import { finalizedInvoiceSql } from "../lib/historical-invoice-hold";
import { Router } from "express";
import { createHash, randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import {
  bankAccounts,
  bankTransactionInvoices,
  bankTransactions,
  db,
  invoices,
  doctorProfiles,
  organizations,
  payments,
  practiceStatementSends,
  practiceStatements,
  providerPaymentAllocations,
  providerPaymentCheckouts,
  providerPaymentCustomers,
  pool,
  systemSettings,
} from "@workspace/db";
import * as workspaceDb from "@workspace/db";
import {
  acquireDepositBatchMutationLock,
  assertDepositBatchChildReversible,
  releaseBatchForChild,
} from "../lib/deposit-batches";
import { writeAuditLog } from "../lib/audit";
import { ensureDefaultCategories } from "../lib/default-categories";
import { HttpError, ok, wrapDbError } from "../lib/http";
import { logger } from "../lib/logger";
import { LAB_LOGO_CID, sendMail } from "../lib/mail";
import { readLabLogoAsset } from "../lib/lab-logo-storage";
import {
  PAYMENT_RECEIPT_PLACEHOLDERS,
  defaultPaymentReceiptTemplate,
  generatePaymentReceiptPdf,
  normalizePaymentReceiptTemplate,
  renderPaymentReceiptTemplate,
  type PaymentReceiptData,
} from "../lib/payment-receipts";
import { SessionAdvisoryLockBundle } from "../lib/session-advisory-lock-bundle";
import {
  loadCustomerDoctorLastPayments,
  loadCustomerLastPayments,
} from "../lib/customer-last-payments";

let heldProviderLocks = 0;
const providerLockWaiters: Array<() => void> = [];

async function acquireProviderAccountLock(
  labOrganizationId: string,
  providerOrganizationId: string,
) {
  const maxHeld = Math.max(1, Number((pool as any).options?.max ?? 10) - 1);
  if (heldProviderLocks >= maxHeld) {
    await new Promise<void>((resolve) => providerLockWaiters.push(resolve));
  }
  heldProviderLocks++;
  let client: any = null;
  let owned = false;
  let counted = true;
  try {
    client = await pool.connect();
    owned = true;
    for (;;) {
      const result = await client.query(
        "SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS acquired",
        [labOrganizationId, providerOrganizationId],
      );
      if (result.rows[0]?.acquired) {
        const bundle = new SessionAdvisoryLockBundle(client);
        bundle.registerUnlock(async () => {
          await client.query(
            "SELECT pg_advisory_unlock(hashtext($1), hashtext($2))",
            [labOrganizationId, providerOrganizationId],
          );
        });
        owned = false;
        return {
          bundle,
          release: async () => {
            try {
              await bundle.release();
            } finally {
              if (counted) {
                counted = false;
                heldProviderLocks--;
                providerLockWaiters.shift()?.();
              }
            }
          },
        };
      }
      client.release();
      owned = false;
      await new Promise((resolve) => setTimeout(resolve, 10));
      // Do not pin a pool connection while waiting for the provider lock.
      client = await pool.connect();
      owned = true;
    }
  } catch (error) {
    if (owned) client?.release();
    if (counted) {
      counted = false;
      heldProviderLocks--;
      providerLockWaiters.shift()?.();
    }
    throw error;
  }
}
import { ADMIN_ROLES, requireAnyRole } from "../lib/rbac";
import { asyncHandler } from "../middlewares/async-handler";
import { requireAuth, requireVerifiedAccount } from "../middlewares/auth";
import { calculateAccountBalance } from "../lib/account-balance";
import { deliverPaymentNotifications } from "../lib/payment-notifications";
import {
  getStripePublishableKey,
  getUncachableStripeClient,
} from "../lib/stripeClient";
import {
  confirmReservedLabCardCharge,
  getOrCreateProviderPaymentCustomer,
  pendingLabCardReservationGuidance,
  reserveLabCardCharge,
} from "./provider";
import { refreshSharedCardSummary } from "../lib/provider-shared-account";
import {
  markProviderPaymentCheckoutFailed,
  settleProviderPaymentCheckout,
} from "../lib/provider-invoice-payments";
import { pageRows, pageRowsKeyset, parsePagination, sortTime } from "../lib/pagination";
import { archiveReversedSettlements } from "../lib/settlement-history";
import { deriveLiveStatementFigures } from "../lib/statement-figures";
import { statementDetailProvenance } from "../lib/statements";

const router = Router();
const {
  customerCredits,
  statementPaymentApplications,
  statementPaymentSessions,
  statementPaymentReversals,
} = workspaceDb;
router.use(requireAuth);
router.use(requireVerifiedAccount);

export function calendarDateInTimeZone(date: Date, timeZone: string): string {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
  } catch {
    throw new HttpError(400, "timeZone must be a valid IANA timezone.");
  }
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

const RECEIPT_TEMPLATE_PREFIX = "tmpl_payment_receipt:";
const PAYMENT_METHODS = ["card", "ach", "check", "cash", "other"] as const;
const OPEN_STATUSES = new Set(["open", "partially_paid", "overdue"]);

function uid(req: any): string {
  return req.auth.userId as string;
}

function money(value: number): string {
  return (Math.round((value + Number.EPSILON) * 100) / 100).toFixed(2);
}

function customerCreditIsNotReservedForReversal() {
  return sql`NOT EXISTS (
    SELECT 1
    FROM statement_payment_reversals reserved_reversal
    WHERE reserved_reversal.payment_session_id = ${customerCredits.paymentSessionId}
      AND reserved_reversal.status <> 'failed'
  )`;
}

/** How the Customer Center names a statement period: "MM-YYYY". */
function statementPeriodLabel(periodStart: Date): string {
  const month = String(periodStart.getUTCMonth() + 1).padStart(2, "0");
  return `${month}-${periodStart.getUTCFullYear()}`;
}

function statementInvoiceIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(value.filter((id): id is string => typeof id === "string" && !!id)),
  );
}

function statementInvoiceAmounts(value: unknown): Map<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return new Map();
  }
  return new Map(
    Object.entries(value as Record<string, unknown>).flatMap(([invoiceId, amount]) =>
      typeof amount === "string" || typeof amount === "number"
        ? [[invoiceId, money(Number(amount))] as const]
        : [],
    ),
  );
}

type StatementInvoiceDetail = {
  invoiceNumber: string;
  patientName: string | null;
  billTo: string | null;
  issuedAt?: string | null;
  dueAt?: string | null;
  status?: string;
};

function statementInvoiceDetails(value: unknown): Map<string, StatementInvoiceDetail> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return new Map();
  return new Map(
    Object.entries(value as Record<string, unknown>).flatMap(([invoiceId, raw]) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
      const detail = raw as Record<string, unknown>;
      if (typeof detail.invoiceNumber !== "string") return [];
      const hasIssuedAt = Object.prototype.hasOwnProperty.call(detail, "issuedAt");
      const hasDueAt = Object.prototype.hasOwnProperty.call(detail, "dueAt");
      return [[
        invoiceId,
        {
          invoiceNumber: detail.invoiceNumber,
          patientName:
            typeof detail.patientName === "string" ? detail.patientName : null,
          billTo: typeof detail.billTo === "string" ? detail.billTo : null,
          ...(hasIssuedAt && (detail.issuedAt === null ||
            typeof detail.issuedAt === "string")
            ? { issuedAt: detail.issuedAt }
            : {}),
          ...(hasDueAt && (detail.dueAt === null ||
            typeof detail.dueAt === "string")
            ? { dueAt: detail.dueAt }
            : {}),
          status:
            typeof detail.status === "string" ? detail.status : undefined,
        },
      ] as const];
    }),
  );
}

function patientName(invoice: { displayMetadataJson: unknown }): string | null {
  const metadata =
    invoice.displayMetadataJson &&
    typeof invoice.displayMetadataJson === "object"
      ? (invoice.displayMetadataJson as Record<string, unknown>)
      : null;
  return typeof metadata?.patientName === "string"
    ? metadata.patientName
    : null;
}

function doctorName(invoice: { displayMetadataJson: unknown }): string | null {
  const metadata =
    invoice.displayMetadataJson &&
    typeof invoice.displayMetadataJson === "object"
      ? (invoice.displayMetadataJson as Record<string, unknown>)
      : null;
  const value = metadata?.billTo ?? metadata?.doctorName;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// Invoices written before stable doctor identities have no identity column
// value, so their scope identity is the normalized immutable display name.
// Newer invoices carry a durable doctorIdentity and always match on it.
function normalizeLegacyDoctorName(name: string | null): string | null {
  return name ? name.trim().replace(/\s+/g, " ").toLocaleLowerCase() : null;
}
function assertInvoiceDoctorScope(
  invoice: { displayMetadataJson: unknown; doctorIdentity: string | null },
  selectedDoctorIdentity: string | null,
  selectedDoctorName: string | null,
): void {
  if (!selectedDoctorIdentity && !selectedDoctorName) return;
  const matches = selectedDoctorIdentity
    ? invoice.doctorIdentity === selectedDoctorIdentity ||
      (invoice.doctorIdentity === null &&
        normalizeLegacyDoctorName(doctorName(invoice)) === selectedDoctorIdentity &&
        normalizeLegacyDoctorName(selectedDoctorName) === selectedDoctorIdentity)
    : invoice.doctorIdentity === null &&
      normalizeLegacyDoctorName(doctorName(invoice)) ===
        normalizeLegacyDoctorName(selectedDoctorName);
  if (!matches) {
    throw new HttpError(400, "Every payment application must belong to the selected doctor.");
  }
}

function invoiceMatchesSelectedDoctor(
  invoice: { displayMetadataJson: unknown; doctorIdentity: string | null },
  selectedDoctorIdentity: string | null,
  selectedDoctorName: string | null,
): boolean {
  if (selectedDoctorIdentity) {
    return (
      invoice.doctorIdentity === selectedDoctorIdentity ||
      (invoice.doctorIdentity === null &&
        normalizeLegacyDoctorName(doctorName(invoice)) === selectedDoctorIdentity &&
        normalizeLegacyDoctorName(selectedDoctorName) === selectedDoctorIdentity)
    );
  }
  return (
    invoice.doctorIdentity === null &&
    normalizeLegacyDoctorName(doctorName(invoice)) ===
      normalizeLegacyDoctorName(selectedDoctorName)
  );
}
function invoiceDoctorOption(invoice: {
  doctorIdentity: string | null;
  displayMetadataJson: unknown;
}): { doctorIdentity: string | null; doctorDisplayName: string } | null {
  const displayName = doctorName(invoice);
  return displayName
    ? {
        doctorIdentity: invoice.doctorIdentity ?? normalizeLegacyDoctorName(displayName),
        doctorDisplayName: displayName,
      }
    : null;
}
async function assertStatementCurrentlyEligible(
  executor: typeof db,
  input: {
    labOrganizationId: string;
    providerOrganizationId: string;
    statementId: string;
  },
): Promise<void> {
  const [latest] = await executor
    .select({ statement: practiceStatements })
    .from(practiceStatementSends)
    .innerJoin(
      practiceStatements,
      eq(practiceStatementSends.statementId, practiceStatements.id),
    )
    .innerJoin(
      organizations,
      eq(practiceStatements.providerOrganizationId, organizations.id),
    )
    .where(
      and(
        eq(practiceStatements.labOrganizationId, input.labOrganizationId),
        eq(
          practiceStatements.providerOrganizationId,
          input.providerOrganizationId,
        ),
        eq(practiceStatementSends.status, "sent"),
        isNull(organizations.deletedAt),
      ),
    )
    .orderBy(
      desc(practiceStatements.periodEnd),
      desc(practiceStatementSends.sentAt),
      desc(practiceStatements.createdAt),
    )
    .limit(1);
  if (!latest || latest.statement.id !== input.statementId) {
    throw new HttpError(
      409,
      "This statement is no longer eligible to receive a payment.",
    );
  }

  const sent = await executor
    .select({ statement: practiceStatements })
    .from(practiceStatementSends)
    .innerJoin(practiceStatements,
      eq(practiceStatementSends.statementId, practiceStatements.id))
    .innerJoin(organizations,
      eq(practiceStatements.providerOrganizationId, organizations.id))
    .where(and(
      eq(practiceStatements.labOrganizationId, input.labOrganizationId),
      eq(practiceStatements.providerOrganizationId, input.providerOrganizationId),
      eq(practiceStatementSends.status, "sent"),
      isNull(organizations.deletedAt),
    ));
  const invoiceIds = Array.from(new Set(sent.flatMap(({ statement }) =>
    statementInvoiceIds(statement.invoiceIdsJson),
  )));
  const [payable] = invoiceIds.length
    ? await executor
        .select({ id: invoices.id })
        .from(invoices)
        .where(
          and(
            inArray(invoices.id, invoiceIds),
            eq(invoices.labOrganizationId, input.labOrganizationId),
            eq(
              invoices.providerOrganizationId,
              input.providerOrganizationId,
            ),
            inArray(invoices.status, [...OPEN_STATUSES]),
            finalizedInvoiceSql(),
            gt(invoices.balanceDue, "0"),
            isNull(invoices.deletedAt),
          ),
        )
        .limit(1)
    : [];
  if (!payable) {
    throw new HttpError(
      409,
      "This statement no longer has an unpaid balance.",
    );
  }
}

/**
 * Invoice-led eligibility. A statement is one way to reach an invoice, not a
 * precondition for paying it: any open, undeleted invoice of this customer
 * account with a positive balance can receive a payment. Callers that hold a
 * row lock re-verify the same conditions before writing; this is the early
 * pre-processor gate so a stale selection never leaves an orphaned charge.
 */
async function assertInvoicesPayableNow(
  executor: typeof db,
  input: {
    labOrganizationId: string;
    providerOrganizationId: string;
    invoiceIds: string[];
  },
): Promise<void> {
  if (!input.invoiceIds.length) {
    throw new HttpError(400, "Select at least one invoice to receive payment.");
  }
  const rows = await executor
    .select({ id: invoices.id })
    .from(invoices)
    .where(
      and(
        inArray(invoices.id, input.invoiceIds),
        eq(invoices.labOrganizationId, input.labOrganizationId),
        eq(invoices.providerOrganizationId, input.providerOrganizationId),
        inArray(invoices.status, [...OPEN_STATUSES]),
        finalizedInvoiceSql(),
        gt(invoices.balanceDue, "0"),
        isNull(invoices.deletedAt),
      ),
    );
  const payable = new Set(rows.map((row) => row.id));
  if (input.invoiceIds.some((invoiceId) => !payable.has(invoiceId))) {
    throw new HttpError(
      409,
      "One or more selected invoices can no longer accept a payment.",
    );
  }
}

async function eligibleStatementInvoices(
  executor: typeof db,
  input: {
    labOrganizationId: string;
    providerOrganizationId: string;
    selectedStatement: typeof practiceStatements.$inferSelect;
  },
): Promise<{
  invoiceIds: Set<string>;
  invoiceAmounts: Map<string, string>;
  invoiceDetails: Map<string, StatementInvoiceDetail>;
}> {
  const rows = await executor.select({ statement: practiceStatements })
    .from(practiceStatementSends)
    .innerJoin(practiceStatements,
      eq(practiceStatementSends.statementId, practiceStatements.id))
    .innerJoin(organizations,
      eq(practiceStatements.providerOrganizationId, organizations.id))
    .where(and(
      eq(practiceStatements.labOrganizationId, input.labOrganizationId),
      eq(practiceStatements.providerOrganizationId, input.providerOrganizationId),
      eq(practiceStatementSends.status, "sent"),
      isNull(organizations.deletedAt),
    ))
    .orderBy(
      desc(practiceStatements.periodEnd),
      desc(practiceStatementSends.sentAt),
      desc(practiceStatements.createdAt),
    );
  const invoiceIds = new Set<string>();
  const invoiceAmounts = new Map<string, string>();
  const invoiceDetails = new Map<string, StatementInvoiceDetail>();
  for (const { statement } of rows) {
    for (const invoiceId of statementInvoiceIds(statement.invoiceIdsJson)) {
      invoiceIds.add(invoiceId);
    }
    for (const [invoiceId, amount] of statementInvoiceAmounts(
      statement.invoiceAmountsJson,
    )) {
      if (!invoiceAmounts.has(invoiceId)) invoiceAmounts.set(invoiceId, amount);
    }
    for (const [invoiceId, detail] of statementInvoiceDetails(
      statement.invoiceDetailsJson,
    )) {
      if (!invoiceDetails.has(invoiceId)) invoiceDetails.set(invoiceId, detail);
    }
  }
  // The explicitly selected statement wins when an invoice appeared on more
  // than one statement; older-only invoices retain their newest exact snapshot.
  for (const [invoiceId, amount] of statementInvoiceAmounts(
    input.selectedStatement.invoiceAmountsJson,
  )) {
    invoiceAmounts.set(invoiceId, amount);
  }
  for (const [invoiceId, detail] of statementInvoiceDetails(
    input.selectedStatement.invoiceDetailsJson,
  )) {
    invoiceDetails.set(invoiceId, detail);
  }
  return { invoiceIds, invoiceAmounts, invoiceDetails };
}

function receiptNumber(id: string, paymentDate: Date): string {
  const y = paymentDate.getUTCFullYear();
  const m = String(paymentDate.getUTCMonth() + 1).padStart(2, "0");
  const d = String(paymentDate.getUTCDate()).padStart(2, "0");
  return `RCP-${y}${m}${d}-${id.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

async function loadReceiptTemplate(labOrganizationId: string) {
  const [row] = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.key, `${RECEIPT_TEMPLATE_PREFIX}${labOrganizationId}`));
  let parsed: unknown = null;
  if (row?.value) {
    try {
      parsed = JSON.parse(row.value);
    } catch {
      parsed = null;
    }
  }
  return normalizePaymentReceiptTemplate(parsed);
}

async function loadPaymentSessionData(
  paymentSessionId: string,
): Promise<PaymentReceiptData & {
  id: string;
  labOrganizationId: string;
  providerOrganizationId: string;
  doctorIdentity: string | null;
  doctorDisplayName: string | null;
  statementId: string | null;
  bankTransactionId: string | null;
  receiptEmailStatus: string | null;
  receiptEmailReason: string | null;
  receiptEmailSentAt: Date | null;
  receiptLogoBase64: string | null;
  receiptLogoContentType: string | null;
  reversal: {
    status: string;
    reason?: string;
    completedAt: Date | null;
  } | null;
}> {
  const [session] = await db
    .select()
    .from(statementPaymentSessions)
    .where(eq(statementPaymentSessions.id, paymentSessionId));
  if (!session) throw new HttpError(404, "Payment session not found.");
  const applications = await db
    .select()
    .from(statementPaymentApplications)
    .where(eq(statementPaymentApplications.paymentSessionId, session.id))
    .orderBy(asc(statementPaymentApplications.createdAt));
  const [reversal] = await db
    .select()
    .from(statementPaymentReversals)
    .where(eq(statementPaymentReversals.paymentSessionId, session.id));
  return {
    id: session.id,
    labOrganizationId: session.labOrganizationId,
    providerOrganizationId: session.providerOrganizationId,
    doctorIdentity: session.doctorIdentity,
    statementId: session.statementId,
    bankTransactionId: session.bankTransactionId,
    receiptNumber: session.receiptNumber,
    labName: session.labName,
    customerName: session.customerName || "Customer",
    // customerName is the immutable provider/practice snapshot captured on
    // the payment session. Keep it explicit in receipt data so historical
    // receipts do not depend on a live organization name.
    practiceName: session.customerName || "Entire practice",
    doctorDisplayName: session.doctorDisplayName,
    customerEmail: session.customerEmail,
    customerAddress:
      session.customerAddressJson &&
      typeof session.customerAddressJson === "object"
        ? (session.customerAddressJson as Record<string, unknown>)
        : null,
    paymentDate: session.paymentDate,
    receivedAmount: session.receivedAmount,
    appliedAmount: session.appliedAmount,
    customerCreditAmount: session.customerCreditAmount,
    accountBalanceAfter: session.accountBalanceAfter,
    paymentMethod: session.paymentMethod,
    checkNumber: session.checkNumber,
    cardLast4: session.cardLast4,
    memo: session.memo,
    status: session.status,
    applications: applications.map((application) => ({
      invoiceNumber: application.invoiceNumber,
      patientName: application.patientName,
      amount: application.amount,
      statementInvoiceAmount:
        application.statementInvoiceAmount ?? application.invoiceTotal,
      invoiceBalanceBefore: application.invoiceBalanceBefore,
      invoiceBalanceAfter: application.invoiceBalanceAfter,
    })),
    receiptEmailStatus: session.receiptEmailStatus,
    receiptEmailReason: session.receiptEmailReason,
    receiptEmailSentAt: session.receiptEmailSentAt,
    receiptLogoBase64: session.receiptLogoBase64,
    receiptLogoContentType: session.receiptLogoContentType,
    reversal: reversal
      ? {
          status: reversal.status === "completed" ? "completed" :
            reversal.status === "failed" ? "failed" : "pending",
          // Deliberately only expose our bounded reason codes, never Stripe's
          // raw error payload which can contain operational details.
          ...(reversal.failureReason ? { reason: reversal.failureReason } : {}),
          completedAt: reversal.completedAt,
        }
      : null,
  };
}

router.get(
  "/:labOrganizationId/eligible-statement-accounts",
  asyncHandler(async (req, res) => {
    const labOrganizationId = String(req.params.labOrganizationId);
    await requireAnyRole(uid(req), labOrganizationId, ADMIN_ROLES);

    const sentStatements = await db
      .select({
        statement: practiceStatements,
        providerName: organizations.name,
        providerAccountNumber: organizations.accountNumber,
        providerCity: organizations.city,
        providerState: organizations.state,
        sentAt: practiceStatementSends.sentAt,
      })
      .from(practiceStatementSends)
      .innerJoin(
        practiceStatements,
        eq(practiceStatementSends.statementId, practiceStatements.id),
      )
      .innerJoin(
        organizations,
        eq(practiceStatements.providerOrganizationId, organizations.id),
      )
      .where(
        and(
          eq(practiceStatements.labOrganizationId, labOrganizationId),
          eq(practiceStatementSends.status, "sent"),
          isNull(organizations.deletedAt),
        ),
      )
      .orderBy(
        desc(practiceStatements.periodEnd),
        desc(practiceStatementSends.sentAt),
        desc(practiceStatements.createdAt),
      );

    // A customer can have several sent statements whose snapshots overlap.
    // Keep every sent statement for display, but build the payable set from a
    // de-duplicated invoice id set so an invoice is never counted twice.
    const byProvider = new Map<string, (typeof sentStatements)>();
    for (const row of sentStatements) {
      const rows = byProvider.get(row.statement.providerOrganizationId) ?? [];
      rows.push(row);
      byProvider.set(row.statement.providerOrganizationId, rows);
    }
    const invoiceIds = Array.from(
      new Set(
        sentStatements.flatMap(({ statement }) =>
          statementInvoiceIds(statement.invoiceIdsJson),
        ),
      ),
    );
    const providerOrganizationIds = Array.from(
      new Set(sentStatements.map(({ statement }) => statement.providerOrganizationId)),
    );
    let doctorProfileRows: Array<{
      id: string;
      doctorName: string;
      displayName: string | null;
      providerOrganizationId: string | null;
    }> = [];
    if (providerOrganizationIds.length) {
      doctorProfileRows = await db
        .select({
          id: doctorProfiles.id,
          doctorName: doctorProfiles.doctorName,
          displayName: doctorProfiles.displayName,
          providerOrganizationId: doctorProfiles.providerOrganizationId,
        })
        .from(doctorProfiles)
        .where(
          and(
            eq(doctorProfiles.labOrganizationId, labOrganizationId),
            inArray(
              doctorProfiles.providerOrganizationId,
              providerOrganizationIds,
            ),
          ),
        );
    }
    const doctorProfilesByProvider = new Map<string, typeof doctorProfileRows>();
    for (const profile of doctorProfileRows) {
      if (!profile.providerOrganizationId) continue;
      const profiles = doctorProfilesByProvider.get(profile.providerOrganizationId) ?? [];
      profiles.push(profile);
      doctorProfilesByProvider.set(profile.providerOrganizationId, profiles);
    }
    const liveInvoices = invoiceIds.length
      ? await db
          .select({
            id: invoices.id,
            invoiceNumber: invoices.invoiceNumber,
            providerOrganizationId: invoices.providerOrganizationId,
            status: invoices.status,
            balanceDue: invoices.balanceDue,
            total: invoices.total,
            issuedAt: invoices.issuedAt,
            dueAt: invoices.dueAt,
            doctorIdentity: invoices.doctorIdentity,
            displayMetadataJson: invoices.displayMetadataJson,
          })
          .from(invoices)
          .where(
            and(
              inArray(invoices.id, invoiceIds),
              eq(invoices.labOrganizationId, labOrganizationId),
              isNull(invoices.deletedAt),
            ),
          )
      : [];
    const liveById = new Map(liveInvoices.map((invoice) => [invoice.id, invoice]));

    const accounts = [...byProvider.entries()]
      .map(([providerOrganizationId, providerRows]) => {
        const latest = providerRows[0];
        const uniqueIds = Array.from(new Set(providerRows.flatMap(({ statement }) =>
          statementInvoiceIds(statement.invoiceIdsJson),
        )));
        const payableIds = uniqueIds.filter((invoiceId) => {
          const invoice = liveById.get(invoiceId);
          return !!invoice &&
            invoice.providerOrganizationId === providerOrganizationId &&
            OPEN_STATUSES.has(invoice.status) &&
            Number(invoice.balanceDue) > 0;
        });
        const invoiceRows = liveInvoices.filter((invoice) =>
          payableIds.includes(invoice.id) &&
          invoice.providerOrganizationId === providerOrganizationId,
        );
        const balance = invoiceRows.reduce(
          (sum, invoice) => sum + Number(invoice.balanceDue),
          0,
        );
        const eligibleRows = providerRows.filter(({ statement }) =>
          statementInvoiceIds(statement.invoiceIdsJson).some((id) =>
            payableIds.includes(id),
          ),
        );
        if (!eligibleRows.length) return null;
        const statementDetails = eligibleRows.map(({ statement, sentAt }) => ({
          statementId: statement.id,
          sentAt,
          periodStart: statement.periodStart,
          periodEnd: statement.periodEnd,
          invoiceCount: statementInvoiceIds(statement.invoiceIdsJson).filter((id) =>
            payableIds.includes(id)).length,
          // The statement's own payable invoices. Statements cover the
          // invoices of their period, so a newer statement does not repeat an
          // older one's, and a statement payment may only settle these.
          invoiceIds: statementInvoiceIds(statement.invoiceIdsJson).filter((id) =>
            payableIds.includes(id)),
          detailProvenance: statementDetailProvenance(
            statementInvoiceIds(statement.invoiceIdsJson),
            statement.invoiceDetailsJson,
          ),
        }));
        const doctors = Array.from(
          new Map(
            invoiceRows
              .map(invoiceDoctorOption)
              .filter((doctor): doctor is NonNullable<typeof doctor> => !!doctor)
              .map((doctor) => [
                doctor.doctorIdentity ??
                  `legacy:${normalizeLegacyDoctorName(doctor.doctorDisplayName)}`,
                doctor,
              ]),
          ).values(),
        ).sort((a, b) => a.doctorDisplayName.localeCompare(b.doctorDisplayName));
        return {
          providerOrganizationId,
          providerName: latest.providerName,
          // The customer's identity as Customer Center shows it.
          accountNumber: latest.providerAccountNumber || null,
          city: latest.providerCity || null,
          state: latest.providerState || null,
          // Keep the newest statement as the compatibility selection target.
          statementId: eligibleRows[0].statement.id,
          periodStart: eligibleRows[0].statement.periodStart,
          periodEnd: eligibleRows[0].statement.periodEnd,
          sentAt: eligibleRows[0].sentAt,
          statementCount: eligibleRows.length,
          sentDates: eligibleRows.map(({ sentAt }) => sentAt),
          periods: eligibleRows.map(({ statement }) => ({
            periodStart: statement.periodStart,
            periodEnd: statement.periodEnd,
          })),
          doctorNames: doctors.map((doctor) => doctor.doctorDisplayName),
          doctors,
          doctorProfiles: (doctorProfilesByProvider.get(providerOrganizationId) ?? [])
            .map((profile) => ({
              id: profile.id,
              doctorName: profile.doctorName,
              doctorDisplayName: profile.displayName || profile.doctorName,
            }))
            .sort((a, b) => a.doctorDisplayName.localeCompare(b.doctorDisplayName)),
          outstandingInvoices: invoiceRows.map((invoice) => ({
            id: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            doctorName: doctorName(invoice),
            // Keep the legacy payment-scope key for compatibility. The
            // separate doctorProfileId tells admins whether this invoice
            // still needs explicit identity repair.
            doctorIdentity:
              invoice.doctorIdentity ?? normalizeLegacyDoctorName(doctorName(invoice)),
            doctorProfileId: invoice.doctorIdentity,
            patientName: patientName(invoice),
            issuedAt: invoice.issuedAt,
            dueAt: invoice.dueAt,
            total: invoice.total,
            currentBalanceDue: invoice.balanceDue,
            eligibleForPayment: true,
            // Explicit aliases make the read model self-describing for
            // non-legacy consumers while preserving the statement-detail
            // invoice shape used by the desktop payment workspace.
            invoiceAmount: invoice.total,
            currentDue: invoice.balanceDue,
          })),
          statements: statementDetails,
          invoiceCount: payableIds.length,
          currentBalanceDue: money(balance),
        };
      })
      .filter((account): account is NonNullable<typeof account> =>
        !!account && Number(account.currentBalanceDue) > 0)
      .sort((a, b) => a.providerName.localeCompare(b.providerName));
    const providerIds = accounts.map((account) => account.providerOrganizationId);
    const [lastPayments, doctorLastPayments] = await Promise.all([
      loadCustomerLastPayments(labOrganizationId, providerIds),
      loadCustomerDoctorLastPayments(labOrganizationId, providerIds),
    ]);

    return ok(
      res,
      accounts.map((account) => {
        const lastPayment = lastPayments.get(account.providerOrganizationId) ?? null;
        return {
          ...account,
          // Most recent non-reversed payment received, by any payment path.
          lastPaymentAt: lastPayment?.paidAt ?? null,
          lastPaymentAmount: lastPayment?.amount ?? null,
          doctorLastPayments: (doctorLastPayments.get(account.providerOrganizationId) ?? [])
            .map((payment) => ({
              doctorIdentity: payment.doctorIdentity,
              lastPaymentAt: payment.paidAt,
              lastPaymentAmount: payment.amount,
            })),
        };
      }),
    );
  }),
);

/**
 * Invoice-led Receive Payments. Lists every customer account that has an
 * outstanding invoice, whether or not a statement was ever generated or sent.
 * The statement-led list above stays exactly as it was for the sequential
 * statement workflow; this is the Customer -> Invoice -> Receive Payment
 * entry point and returns the same account shape minus statement snapshots.
 */
router.get(
  "/:labOrganizationId/eligible-invoice-accounts",
  asyncHandler(async (req, res) => {
    const labOrganizationId = String(req.params.labOrganizationId);
    await requireAnyRole(uid(req), labOrganizationId, ADMIN_ROLES);

    const rows = await db
      .select({
        invoice: {
          id: invoices.id,
          invoiceNumber: invoices.invoiceNumber,
          providerOrganizationId: invoices.providerOrganizationId,
          status: invoices.status,
          balanceDue: invoices.balanceDue,
          total: invoices.total,
          issuedAt: invoices.issuedAt,
          dueAt: invoices.dueAt,
          doctorIdentity: invoices.doctorIdentity,
          displayMetadataJson: invoices.displayMetadataJson,
        },
        providerName: organizations.name,
        providerAccountNumber: organizations.accountNumber,
        providerCity: organizations.city,
        providerState: organizations.state,
      })
      .from(invoices)
      .innerJoin(organizations, eq(invoices.providerOrganizationId, organizations.id))
      .where(
        and(
          eq(invoices.labOrganizationId, labOrganizationId),
          inArray(invoices.status, [...OPEN_STATUSES]),
          finalizedInvoiceSql(),
          gt(invoices.balanceDue, "0"),
          isNull(invoices.deletedAt),
          isNull(organizations.deletedAt),
        ),
      )
      .orderBy(asc(invoices.dueAt), asc(invoices.issuedAt), asc(invoices.id));

    const byProvider = new Map<string, typeof rows>();
    for (const row of rows) {
      const providerId = row.invoice.providerOrganizationId;
      if (!providerId) continue;
      const existing = byProvider.get(providerId) ?? [];
      existing.push(row);
      byProvider.set(providerId, existing);
    }
    const providerIds = [...byProvider.keys()];
    const [lastPayments, doctorLastPayments] = await Promise.all([
      loadCustomerLastPayments(labOrganizationId, providerIds),
      loadCustomerDoctorLastPayments(labOrganizationId, providerIds),
    ]);
    const profileRows = providerIds.length
      ? await db
          .select({
            id: doctorProfiles.id,
            doctorName: doctorProfiles.doctorName,
            displayName: doctorProfiles.displayName,
            providerOrganizationId: doctorProfiles.providerOrganizationId,
          })
          .from(doctorProfiles)
          .where(
            and(
              eq(doctorProfiles.labOrganizationId, labOrganizationId),
              inArray(doctorProfiles.providerOrganizationId, providerIds),
            ),
          )
      : [];
    const profilesByProvider = new Map<string, typeof profileRows>();
    for (const profile of profileRows) {
      if (!profile.providerOrganizationId) continue;
      const profiles = profilesByProvider.get(profile.providerOrganizationId) ?? [];
      profiles.push(profile);
      profilesByProvider.set(profile.providerOrganizationId, profiles);
    }

    return ok(
      res,
      [...byProvider.entries()]
        .map(([providerOrganizationId, providerRows]) => {
          const invoiceRows = providerRows.map((row) => row.invoice);
          const lastPayment = lastPayments.get(providerOrganizationId) ?? null;
          const balance = invoiceRows.reduce(
            (total, invoice) => total + Number(invoice.balanceDue),
            0,
          );
          const doctors = Array.from(
            new Map(
              invoiceRows
                .map(invoiceDoctorOption)
                .filter((doctor): doctor is NonNullable<typeof doctor> => !!doctor)
                .map((doctor) => [
                  doctor.doctorIdentity ??
                    `legacy:${normalizeLegacyDoctorName(doctor.doctorDisplayName)}`,
                  doctor,
                ]),
            ).values(),
          ).sort((a, b) => a.doctorDisplayName.localeCompare(b.doctorDisplayName));
          return {
            providerOrganizationId,
            providerName: providerRows[0].providerName,
            // The customer's identity as Customer Center shows it.
            accountNumber: providerRows[0].providerAccountNumber || null,
            city: providerRows[0].providerCity || null,
            state: providerRows[0].providerState || null,
            // Most recent non-reversed payment received, by any payment path.
            lastPaymentAt: lastPayment?.paidAt ?? null,
            lastPaymentAmount: lastPayment?.amount ?? null,
            doctorLastPayments: (doctorLastPayments.get(providerOrganizationId) ?? [])
              .map((payment) => ({
                doctorIdentity: payment.doctorIdentity,
                lastPaymentAt: payment.paidAt,
                lastPaymentAmount: payment.amount,
              })),
            doctorNames: doctors.map((doctor) => doctor.doctorDisplayName),
            doctors,
            doctorProfiles: (profilesByProvider.get(providerOrganizationId) ?? [])
              .map((profile) => ({
                id: profile.id,
                doctorName: profile.doctorName,
                doctorDisplayName: profile.displayName || profile.doctorName,
              }))
              .sort((a, b) => a.doctorDisplayName.localeCompare(b.doctorDisplayName)),
            outstandingInvoices: invoiceRows.map((invoice) => ({
              id: invoice.id,
              invoiceNumber: invoice.invoiceNumber,
              doctorName: doctorName(invoice),
              doctorIdentity:
                invoice.doctorIdentity ?? normalizeLegacyDoctorName(doctorName(invoice)),
              patientName: patientName(invoice),
              issuedAt: invoice.issuedAt,
              dueAt: invoice.dueAt,
              total: invoice.total,
              currentBalanceDue: invoice.balanceDue,
              eligibleForPayment: true,
              invoiceAmount: invoice.total,
              currentDue: invoice.balanceDue,
            })),
            invoiceCount: invoiceRows.length,
            currentBalanceDue: money(balance),
          };
        })
        .sort((a, b) => a.providerName.localeCompare(b.providerName)),
    );
  }),
);

router.get(
  "/:labOrganizationId/accounts/:providerOrganizationId/statements",
  asyncHandler(async (req, res) => {
    const pagination = parsePagination(req.query);
    const labOrganizationId = String(req.params.labOrganizationId);
    const providerOrganizationId = String(req.params.providerOrganizationId);
    await requireAnyRole(uid(req), labOrganizationId, ADMIN_ROLES);
    const rows = await db.query.practiceStatements.findMany({
      where: and(
        eq(practiceStatements.labOrganizationId, labOrganizationId),
        eq(practiceStatements.providerOrganizationId, providerOrganizationId),
      ),
      orderBy: [
        desc(practiceStatements.periodEnd),
        desc(practiceStatements.createdAt),
        desc(practiceStatements.id),
      ],
    });
    const invoiceIds = Array.from(
      new Set(rows.flatMap((row) => statementInvoiceIds(row.invoiceIdsJson))),
    );
    const currentBalances = invoiceIds.length
      ? await db
          .select({
            id: invoices.id,
            total: invoices.total,
            balanceDue: invoices.balanceDue,
            status: invoices.status,
          })
          .from(invoices)
          .where(
            and(
              inArray(invoices.id, invoiceIds),
              eq(invoices.labOrganizationId, labOrganizationId),
              eq(invoices.providerOrganizationId, providerOrganizationId),
              isNull(invoices.deletedAt),
            ),
          )
      : [];
    const invoiceStateById = new Map(
      currentBalances.map((invoice) => [invoice.id, invoice]),
    );
    const enriched = rows.map((row) => {
        const invoiceIds = statementInvoiceIds(row.invoiceIdsJson);
        const detailProvenance = statementDetailProvenance(
          invoiceIds,
          row.invoiceDetailsJson,
        );
        const live = deriveLiveStatementFigures(
          invoiceIds,
          invoiceStateById,
        );
        return {
          id: row.id,
          periodStart: row.periodStart,
          periodEnd: row.periodEnd,
          invoiceCount: row.invoiceCount,
          totalBilled: row.totalBilled,
          // Statements are immutable snapshots, while these are deliberately
          // the live figures from the snapshot's current invoice balances.
          totalPaid: live.totalPaid,
          currentTotalPaid: live.totalPaid,
          currentBalanceDue: live.balanceDue,
          balanceDue: live.balanceDue,
          // Kept for compatibility, but it now intentionally means live
          // balance; callers needing the generated snapshot use snapshotBalanceDue.
          savedBalanceDue: live.balanceDue,
          snapshotTotalPaid: row.totalPaid,
          snapshotBalanceDue: row.balanceDue,
          hasInvoiceDetailSnapshots: detailProvenance === "snapshot",
          detailProvenance,
          invoiceIds,
          createdAt: row.createdAt,
        };
      });
    if (!pagination.active) return ok(res, enriched);
    return ok(res, {
      providerOrganizationId,
      // Matches the query order: periodEnd, then createdAt, then id — all
      // descending — so a cursor anchors the next batch exactly.
      ...pageRowsKeyset(enriched, pagination, {
        sortValues: (row) => [sortTime(row.periodEnd), sortTime(row.createdAt)],
        id: (row) => String(row.id),
        directions: ["desc", "desc"],
        idDirection: "desc",
      }),
    });
  }),
);

router.get(
  "/statements/:statementId",
  asyncHandler(async (req, res) => {
    const statementId = String(req.params.statementId);
    const statement = await db.query.practiceStatements.findFirst({
      where: eq(practiceStatements.id, statementId),
    });
    if (!statement) throw new HttpError(404, "Statement not found.");
    await requireAnyRole(uid(req), statement.labOrganizationId, ADMIN_ROLES);
    const ids = statementInvoiceIds(statement.invoiceIdsJson);
    const rows = ids.length
      ? await db
          .select()
          .from(invoices)
          .where(
            and(
              inArray(invoices.id, ids),
              eq(invoices.labOrganizationId, statement.labOrganizationId),
              eq(invoices.providerOrganizationId, statement.providerOrganizationId),
              isNull(invoices.deletedAt),
            ),
          )
      : [];
    const byId = new Map(rows.map((row) => [row.id, row]));
    const details = statementInvoiceDetails(statement.invoiceDetailsJson);
    const amounts = statementInvoiceAmounts(statement.invoiceAmountsJson);
    const detailProvenance = statementDetailProvenance(
      ids,
      statement.invoiceDetailsJson,
    );
    const invoicesInSnapshot = ids
      .map((id) => {
        const row = byId.get(id);
        const detail = details.get(id);
        return {
          id,
          invoiceNumber: detail?.invoiceNumber ?? row?.invoiceNumber ?? "Unavailable",
          patientName: detail ? detail.patientName : row ? patientName(row) : null,
          billTo: detail ? detail.billTo : row ? doctorName(row) : null,
          // These are issued-statement facts. New statements always read them
          // from the immutable snapshot; legacy statements fall back to the live
          // invoice because they predate exact date/status capture.
          status: detail?.status ?? row?.status ?? "deleted",
          issuedAt: detail && "issuedAt" in detail
            ? detail.issuedAt
            : row?.issuedAt ?? null,
          dueAt: detail && "dueAt" in detail ? detail.dueAt : row?.dueAt ?? null,
          total: amounts.get(id) ?? row?.total ?? "0.00",
          // Settlement and payment eligibility intentionally remain live.
          currentBalanceDue: row?.balanceDue ?? "0.00",
          eligibleForPayment:
            !!row && OPEN_STATUSES.has(row.status) && Number(row.balanceDue) > 0,
          detailProvenance: detail ? "snapshot" : row ? "live" : "unavailable",
        };
      });
    // Same live derivation as the account-statement list, so a statement can
    // never look settled in the list and unpaid in the detail Receive
    // Payments reads (or the other way round).
    const live = deriveLiveStatementFigures(ids, new Map(rows.map((row) => [row.id, row])));
    return ok(res, {
      id: statement.id,
      labOrganizationId: statement.labOrganizationId,
      providerOrganizationId: statement.providerOrganizationId,
      periodStart: statement.periodStart,
      periodEnd: statement.periodEnd,
      invoiceCount: statement.invoiceCount,
      totalBilled: statement.totalBilled,
      totalPaid: live.totalPaid,
      currentTotalPaid: live.totalPaid,
      balanceDue: live.balanceDue,
      currentBalanceDue: live.balanceDue,
      // Kept for compatibility, and now the live payable balance; callers
      // needing the generated snapshot use snapshotBalanceDue.
      savedBalanceDue: live.balanceDue,
      snapshotTotalPaid: statement.totalPaid,
      snapshotBalanceDue: statement.balanceDue,
      hasInvoiceDetailSnapshots: detailProvenance === "snapshot",
      detailProvenance,
      invoices: invoicesInSnapshot,
    });
  }),
);

const createPaymentSessionSchema = z
  .object({
    labOrganizationId: z.string().min(1),
    providerOrganizationId: z.string().min(1),
    doctorIdentity: z.string().trim().min(1).nullish(),
    doctorName: z.string().trim().min(1).nullish(),
    // Optional. Omit it to receive payment directly against eligible
    // outstanding invoices -- the Customer -> Invoice -> Receive Payment flow.
    // Supplying it keeps the statement-led flow exactly as it was.
    statementId: z.string().min(1).nullish(),
    receivedAmount: z.coerce.number().min(0).max(999999999.99).default(0),
    existingCreditAmount: z.coerce.number().min(0).max(999999999.99).default(0),
    paymentDate: z.string().nullish(),
    paymentMethod: z.enum(PAYMENT_METHODS),
    checkNumber: z.string().trim().max(100).nullish(),
    referenceNumber: z.string().trim().min(1).max(100).nullish(),
    cardLast4: z.string().regex(/^\d{4}$/).nullish(),
    memo: z.string().max(2000).nullish(),
    customerEmail: z.union([z.literal(""), z.string().email().max(320)]).nullish(),
    idempotencyKey: z.string().trim().min(8).max(200).optional(),
    // Inline card flow supplies the server-created intent after Stripe.js has
    // collected the payment method. Card fields themselves are never accepted.
    paymentIntentId: z.string().min(1).optional(),
    savePaymentMethod: z.boolean().default(false),
    applications: z
      .array(
        z.object({
          invoiceId: z.string().min(1),
          amount: z.coerce.number().min(0).max(999999999.99),
          // Optional independently-controlled credit allocation. `amount`
          // remains the monetary allocation for backwards compatibility.
          creditAmount: z.coerce.number().min(0).max(999999999.99).default(0),
        }),
      )
      .max(500)
      .default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    value.applications.forEach((application, index) => {
      if (application.amount <= 0 && application.creditAmount <= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["applications", index, "amount"],
          message: "An invoice allocation must include a monetary or credit amount.",
        });
      }
    });
    const explicitCredit = value.applications.reduce(
      (sum, application) => sum + application.creditAmount, 0,
    );
    if (value.receivedAmount <= 0 &&
      value.existingCreditAmount <= 0 && explicitCredit <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["receivedAmount"],
        message: "Enter a monetary amount or apply available customer credit.",
      });
    }
    if (
      value.receivedAmount > 0 &&
      value.paymentMethod === "check" &&
      !value.checkNumber?.trim()
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["checkNumber"],
        message: "Check number is required for check payments.",
      });
    }
    if (
      value.receivedAmount > 0 &&
      value.paymentMethod === "card" &&
      !value.paymentIntentId &&
      !value.cardLast4
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cardLast4"],
        message: "Card last four is required for card payments.",
      });
    }
    if (
      value.receivedAmount > 0 &&
      (value.paymentMethod === "ach" || value.paymentMethod === "other") &&
      !value.referenceNumber?.trim()
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["referenceNumber"],
        message: "Reference number is required for ACH and other payments.",
      });
    }
  });

const inlineCardPrepareSchema = z.object({
  labOrganizationId: z.string().min(1),
  providerOrganizationId: z.string().min(1),
  doctorIdentity: z.string().trim().min(1).nullish(),
  doctorName: z.string().trim().min(1).nullish(),
  // Optional, matching the manual receipt writer: omit it to charge a card
  // against eligible outstanding invoices without a sent statement.
  statementId: z.string().min(1).nullish(),
  receivedAmount: z.coerce.number().positive().max(999999999.99),
  existingCreditAmount: z.coerce.number().min(0).max(999999999.99).default(0),
  paymentDate: z.string().nullish(),
  paymentMethod: z.literal("card"),
  memo: z.string().max(2000).nullish(),
  customerEmail: z.union([z.literal(""), z.string().email().max(320)]).nullish(),
  idempotencyKey: z.string().trim().min(8).max(200),
  savePaymentMethod: z.boolean().default(false),
  applications: z.array(z.object({
    invoiceId: z.string().min(1),
    amount: z.coerce.number().min(0).max(999999999.99),
    creditAmount: z.coerce.number().min(0).max(999999999.99).default(0),
  }).strict()).min(1).max(500),
}).strict();

// This symbol can only be held by this module. It lets Stripe webhook recovery
// use the authorization captured when the immutable draft was prepared,
// without allowing an HTTP request body/header to bypass current role checks.
const TRUSTED_INLINE_WEBHOOK = Symbol("trusted-inline-payment-webhook");

function inlineCardFingerprint(input: z.infer<typeof inlineCardPrepareSchema>) {
  return createHash("sha256").update(JSON.stringify({
    labOrganizationId: input.labOrganizationId,
    providerOrganizationId: input.providerOrganizationId,
    doctorIdentity: input.doctorIdentity ?? null,
    doctorName: input.doctorName ?? null,
    statementId: input.statementId ?? null,
    receivedAmount: money(input.receivedAmount),
    paymentDate: input.paymentDate ?? null,
    memo: input.memo ?? null,
    customerEmail: input.customerEmail ?? null,
    existingCreditAmount: money(input.existingCreditAmount),
    savePaymentMethod: input.savePaymentMethod,
    applications: [...input.applications].sort((a, b) =>
      a.invoiceId.localeCompare(b.invoiceId)),
  })).digest("hex");
}

export type InlineCardReservationReconciliation = {
  found: number;
  succeeded: number;
  released: number;
  deferred: number;
};

export async function reconcileExpiredInlineCardReservations(
  invoiceIds?: string[],
): Promise<InlineCardReservationReconciliation> {
  const staleRows = await db
    .select({
      checkoutId: providerPaymentCheckouts.id,
    })
    .from(providerPaymentAllocations)
    .innerJoin(
      providerPaymentCheckouts,
      eq(providerPaymentAllocations.checkoutId, providerPaymentCheckouts.id),
    )
    .innerJoin(
      invoices,
      eq(providerPaymentAllocations.invoiceId, invoices.id),
    )
    .where(and(
      ...(invoiceIds?.length
        ? [inArray(providerPaymentAllocations.invoiceId, invoiceIds)]
        : []),
      eq(providerPaymentCheckouts.status, "pending"),
      sql`${providerPaymentCheckouts.inlineDraftJson} IS NOT NULL`,
      sql`${providerPaymentCheckouts.expiresAt} IS NOT NULL`,
      sql`${providerPaymentCheckouts.expiresAt} <= NOW()`,
    ));
  const unique = new Map(staleRows.map((row) => [row.checkoutId, row]));
  const result: InlineCardReservationReconciliation = {
    found: unique.size,
    succeeded: 0,
    released: 0,
    deferred: 0,
  };
  if (!unique.size) return result;
  const stripe = await getUncachableStripeClient();
  if (!stripe) {
    result.deferred = unique.size;
    return result;
  }
  for (const row of unique.values()) {
    try {
      // The scan can race a confirmation request or another scheduler
      // instance. Re-read the durable state immediately before contacting
      // Stripe so a checkout that already settled or was released is never
      // acted on again.
      const [current] = await db
        .select({
          status: providerPaymentCheckouts.status,
          expiresAt: providerPaymentCheckouts.expiresAt,
          inlineDraftJson: providerPaymentCheckouts.inlineDraftJson,
          paymentIntentId: providerPaymentCheckouts.stripePaymentIntentId,
        })
        .from(providerPaymentCheckouts)
        .where(eq(providerPaymentCheckouts.id, row.checkoutId))
        .limit(1);
      if (
        !current ||
        current.status !== "pending" ||
        !current.inlineDraftJson ||
        !current.expiresAt ||
        current.expiresAt.getTime() > Date.now()
      ) {
        continue;
      }
      if (!current.paymentIntentId) {
        // A worker can die after reserving invoices but before persisting the
        // intent ID. Releasing here could race an accepted Stripe create call,
        // so this state remains fenced until a later pass or webhook resolves
        // the processor outcome.
        result.deferred++;
        continue;
      }
      const intent = await stripe.paymentIntents.retrieve(current.paymentIntentId);
      if (intent.status === "succeeded") {
        await finalizeInlinePaymentIntentFromWebhook(row.checkoutId, intent.id);
        result.succeeded++;
        continue;
      }
      if (intent.status === "canceled") {
        await markProviderPaymentCheckoutFailed(
          row.checkoutId, "expired", "inline_payment_intent_canceled", intent.id,
        );
        result.released++;
        continue;
      }
      if (intent.status === "requires_payment_method") {
        // Stripe has confirmed that this intent has no usable payment method
        // and cannot settle as-is. It is safe to release this checkout's
        // invoice reservation, while later/ambiguous states stay fenced.
        await markProviderPaymentCheckoutFailed(
          row.checkoutId,
          "failed",
          "inline_payment_intent_terminal_failure",
          intent.id,
        );
        result.released++;
        continue;
      }
      // Stripe cancellation is the authoritative fence release. If cancellation
      // races confirmation or Stripe reports an ambiguous state, leave the
      // checkout pending so no replacement payment can touch these invoices.
      const canceled = await stripe.paymentIntents.cancel(intent.id);
      if (canceled.status === "canceled") {
        await markProviderPaymentCheckoutFailed(
          row.checkoutId, "expired", "inline_payment_intent_expired", intent.id,
        );
        result.released++;
      } else {
        result.deferred++;
      }
    } catch (error) {
      // Retain the durable pending fence. A webhook or later request retries
      // reconciliation; releasing it on an uncertain processor outcome could
      // permit two charges against the same invoice.
      logger.warn(
        { err: error instanceof Error ? error.message : error, checkoutId: row.checkoutId },
        "[payment-sessions] Inline card reconciliation deferred",
      );
      result.deferred++;
    }
  }
  return result;
}

router.get("/payment-sessions/card/config", asyncHandler(async (req, res) => {
  const labOrganizationId = String(req.query.labOrganizationId ?? "");
  if (!labOrganizationId) throw new HttpError(400, "labOrganizationId is required.");
  await requireAnyRole(uid(req), labOrganizationId, ADMIN_ROLES);
  const publishableKey = await getStripePublishableKey();
  if (!publishableKey) {
    throw new HttpError(503, "Stripe card payments are not configured.");
  }
  return ok(res, { publishableKey });
}));

// Inline new-card flow: reserve and create an unconfirmed intent only. The
// complete draft is fingerprinted into Stripe metadata and is replay-safe.
router.post("/payment-sessions/card/prepare", asyncHandler(async (req, res) => {
    const callerId = uid(req);
    const input = inlineCardPrepareSchema.parse(req.body);
  await requireAnyRole(callerId, input.labOrganizationId, ADMIN_ROLES);
  const statementId = input.statementId ?? null;
  const [statement, provider, lab] = await Promise.all([
    statementId
      ? db.query.practiceStatements.findFirst({ where: eq(practiceStatements.id, statementId) })
      : Promise.resolve(undefined),
    db.query.organizations.findFirst({ where: eq(organizations.id, input.providerOrganizationId) }),
    db.query.organizations.findFirst({ where: eq(organizations.id, input.labOrganizationId) }),
  ]);
  if (statementId && (!statement ||
      statement.labOrganizationId !== input.labOrganizationId ||
      statement.providerOrganizationId !== input.providerOrganizationId)) {
    throw new HttpError(404, "Statement not found for this customer account.");
  }
  if (!provider || provider.parentLabOrganizationId !== input.labOrganizationId ||
      !lab) throw new HttpError(404, "Customer account not found for this lab.");
  await reconcileExpiredInlineCardReservations(
    input.applications.map((application) => application.invoiceId),
  );
  // Do all local eligibility and capacity checks before touching Stripe.  In
  // particular, a stale statement or credit balance must never leave an
  // orphaned processor intent behind.  An existing reservation is a replay of
  // a previously accepted draft, so it is safe to resume even if eligibility
  // has since moved on.
  const [existingReservation] = await db
    .select({ id: providerPaymentCheckouts.id })
    .from(providerPaymentCheckouts)
    .where(and(
      eq(providerPaymentCheckouts.providerOrganizationId, input.providerOrganizationId),
      eq(providerPaymentCheckouts.clientRequestId, input.idempotencyKey),
    ))
    .limit(1);
  if (!existingReservation && statementId && statement) {
    await assertStatementCurrentlyEligible(db, {
      labOrganizationId: input.labOrganizationId,
      providerOrganizationId: input.providerOrganizationId,
      statementId,
    });
  }
  if (statement) {
    const eligibleStatementInvoicesSnapshot = await eligibleStatementInvoices(db, {
      labOrganizationId: input.labOrganizationId,
      providerOrganizationId: input.providerOrganizationId,
      selectedStatement: statement,
    });
    if (input.applications.some(
      (application) => !eligibleStatementInvoicesSnapshot.invoiceIds.has(application.invoiceId),
    )) {
      throw new HttpError(400, "Every invoice application must belong to the selected statement.");
    }
  } else {
    // Invoice-led: the payable set is the account's own outstanding invoices.
    await assertInvoicesPayableNow(db, {
      labOrganizationId: input.labOrganizationId,
      providerOrganizationId: input.providerOrganizationId,
      invoiceIds: input.applications
        .filter((application) => application.amount > 0)
        .map((application) => application.invoiceId),
    });
  }
  if (input.doctorIdentity || input.doctorName) {
    const scopedRows = await db.select({
      displayMetadataJson: invoices.displayMetadataJson,
      doctorIdentity: invoices.doctorIdentity,
    })
      .from(invoices)
      .where(and(
        inArray(invoices.id, input.applications.map((application) => application.invoiceId)),
        eq(invoices.labOrganizationId, input.labOrganizationId),
        eq(invoices.providerOrganizationId, input.providerOrganizationId),
      ));
    for (const invoice of scopedRows) {
      assertInvoiceDoctorScope(invoice, input.doctorIdentity ?? null, input.doctorName ?? null);
    }
  }
    const duplicateInvoiceIds = input.applications.filter(
      (application, index, all) =>
        all.findIndex((candidate) => candidate.invoiceId === application.invoiceId) !==
        index,
    );
    if (duplicateInvoiceIds.length) {
      throw new HttpError(400, "Each invoice may be applied only once.");
    }
    const totalApplied = input.applications.reduce(
      (sum, application) => sum + application.amount,
      0,
    );
  if (totalApplied <= 0.005) {
    throw new HttpError(400, "At least one invoice must have a positive card allocation.");
  }
  if (totalApplied > input.receivedAmount + 0.005) {
    throw new HttpError(400, "Invoice applications cannot exceed the amount received.");
  }
  if (input.existingCreditAmount > 0 ||
      input.applications.some((application) => application.creditAmount > 0)) {
    throw new HttpError(
      400,
      "Apply existing customer credit separately before charging a new card.",
    );
  }
  const fingerprint = inlineCardFingerprint(input);
  const stripe = await getUncachableStripeClient();
  if (!stripe) throw new HttpError(503, "Stripe card payments are not configured.");
  const reservation = await reserveLabCardCharge(
    input.labOrganizationId, input.providerOrganizationId,
    input.applications.filter((a) => a.amount > 0).map((a) => ({
      invoiceId: a.invoiceId, amount: Math.round(a.amount * 100),
    })),
    input.idempotencyKey,
    callerId,
    Math.round(input.receivedAmount * 100),
    false,
    input.savePaymentMethod,
    new Date(Date.now() + 30 * 60 * 1000),
  );
  const canonicalDraft = {
    labOrganizationId: input.labOrganizationId,
    providerOrganizationId: input.providerOrganizationId,
    doctorIdentity: input.doctorIdentity ?? null,
    doctorName: input.doctorName ?? null,
    statementId: input.statementId ?? null,
    receivedAmount: money(input.receivedAmount),
    existingCreditAmount: money(input.existingCreditAmount),
    paymentDate: input.paymentDate ?? null,
    paymentMethod: "card" as const,
    memo: input.memo ?? null,
    customerEmail: input.customerEmail ?? null,
    savePaymentMethod: input.savePaymentMethod,
    applications: input.applications.map((application) => ({
      invoiceId: application.invoiceId,
      amount: money(application.amount),
      creditAmount: money(application.creditAmount),
    })).sort((a, b) => a.invoiceId.localeCompare(b.invoiceId)),
  };
  if (reservation.checkout.inlineDraftFingerprint &&
      reservation.checkout.inlineDraftFingerprint !== fingerprint) {
    throw new HttpError(409, "This idempotency key was already used for a different payment draft.");
  }
  if (!reservation.checkout.inlineDraftFingerprint) {
    await db.update(providerPaymentCheckouts).set({
      inlineDraftJson: canonicalDraft,
      inlineDraftFingerprint: fingerprint,
      updatedAt: new Date(),
    }).where(eq(providerPaymentCheckouts.id, reservation.checkout.id));
  }
  const customerId = input.savePaymentMethod
    ? await getOrCreateProviderPaymentCustomer(input.providerOrganizationId, stripe)
    : null;
  if (reservation.checkout.stripePaymentIntentId) {
    const intent = await stripe.paymentIntents.retrieve(
      reservation.checkout.stripePaymentIntentId,
    );
    return ok(res, {
      checkoutId: reservation.checkout.id,
      paymentIntentId: intent.id,
      clientSecret: intent.client_secret,
      status: intent.status,
      totalAmount: reservation.checkout.totalAmount,
    });
  }
  const intent = await stripe.paymentIntents.create({
    amount: Math.round(input.receivedAmount * 100), currency: "usd",
    ...(customerId ? { customer: customerId, setup_future_usage: "off_session" as const } : {}),
    payment_method_types: ["card"],
    metadata: {
      providerPaymentCheckoutId: reservation.checkout.id,
      providerOrganizationId: input.providerOrganizationId,
      labOrganizationId: input.labOrganizationId,
      receivePaymentFingerprint: fingerprint,
    },
  }, { idempotencyKey: `provider-inline-payment-intent-${reservation.checkout.id}` });
  await db.update(providerPaymentCheckouts).set({ stripePaymentIntentId: intent.id, updatedAt: new Date() })
    .where(eq(providerPaymentCheckouts.id, reservation.checkout.id));
  return ok(res, { checkoutId: reservation.checkout.id, paymentIntentId: intent.id,
    clientSecret: intent.client_secret, status: intent.status, totalAmount: reservation.checkout.totalAmount }, 201);
}));

router.post(
  "/payment-sessions",
  asyncHandler(async (req, res) => {
    const callerId = uid(req);
    const parsedInput = createPaymentSessionSchema.parse(req.body);
    // New clients may put credit allocations on individual application rows;
    // fold those into the legacy account-level total so old accounting logic
    // and idempotency fingerprints continue to cover the complete request.
    const explicitCreditAmount = parsedInput.applications.reduce(
      (sum, application) => sum + application.creditAmount,
      0,
    );
    const input = {
      ...parsedInput,
      existingCreditAmount: Math.max(
        parsedInput.existingCreditAmount,
        explicitCreditAmount,
      ),
    };
    await requireAnyRole(callerId, input.labOrganizationId, ADMIN_ROLES);
    if (input.receivedAmount > 0 && input.paymentMethod === "card") {
      throw new HttpError(
        400,
        "Use /billing/payment-sessions/card to charge a saved card securely.",
      );
    }
    const paymentDate = input.paymentDate
      ? new Date(input.paymentDate)
      : new Date();
    if (Number.isNaN(paymentDate.getTime())) {
      throw new HttpError(400, "Invalid payment date.");
    }
    const duplicateInvoiceIds = input.applications.filter(
      (application, index, all) =>
        all.findIndex((candidate) => candidate.invoiceId === application.invoiceId) !==
        index,
    );
    if (duplicateInvoiceIds.length) {
      throw new HttpError(400, "Each invoice may be applied only once.");
    }
    const totalApplied = input.applications.reduce(
      (sum, application) => sum + application.amount,
      0,
    );
    if (totalApplied > input.receivedAmount + 0.005) {
      throw new HttpError(
        400,
        "Invoice applications cannot exceed the amount received.",
      );
    }

    const [ufAccount, provider, lab] = await Promise.all([
      db.query.bankAccounts.findFirst({
        where: and(
          eq(bankAccounts.labOrganizationId, input.labOrganizationId),
          eq(bankAccounts.accountType, "undeposited_funds"),
        ),
      }),
      db.query.organizations.findFirst({
        where: eq(organizations.id, input.providerOrganizationId),
      }),
      db.query.organizations.findFirst({
        where: eq(organizations.id, input.labOrganizationId),
      }),
    ]);
    if (input.receivedAmount > 0 && !ufAccount) {
      throw new HttpError(
        422,
        "No Undeposited Funds account found for this lab.",
      );
    }
    if (
      !provider ||
      provider.type !== "provider" ||
      provider.parentLabOrganizationId !== input.labOrganizationId
    ) {
      throw new HttpError(404, "Customer account not found for this lab.");
    }
    if (!lab || lab.type !== "lab") {
      throw new HttpError(404, "Lab not found.");
    }
    const shouldSnapshotLogo =
      !!lab.logoUrl &&
      (lab.logoplacements == null ||
        lab.logoplacements.includes("payment_receipts"));
    const receiptLogo = shouldSnapshotLogo
      ? await readLabLogoAsset(input.labOrganizationId)
      : null;
    const requestFingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          labOrganizationId: input.labOrganizationId,
          providerOrganizationId: input.providerOrganizationId,
          doctorIdentity: input.doctorIdentity ?? null,
          doctorName: input.doctorName ?? null,
          statementId: input.statementId ?? null,
          receivedAmount: money(input.receivedAmount),
          existingCreditAmount: money(input.existingCreditAmount),
          paymentDate: input.paymentDate ?? null,
          paymentMethod: input.paymentMethod,
          checkNumber: input.checkNumber?.trim() || null,
          referenceNumber: input.referenceNumber?.trim() || null,
          cardLast4: input.cardLast4 ?? null,
          memo: input.memo?.trim() || null,
          customerEmail: input.customerEmail?.trim() || null,
          applications: [...input.applications]
            .map((application) => ({
              invoiceId: application.invoiceId,
              amount: money(application.amount),
              creditAmount: money(application.creditAmount),
            }))
            .sort((a, b) => a.invoiceId.localeCompare(b.invoiceId)),
        }),
      )
      .digest("hex");

    let arCategoryId: string | null = null;
    try {
      arCategoryId = (
        await ensureDefaultCategories(input.labOrganizationId)
      ).accountsReceivable.id;
    } catch {
      arCategoryId = null;
    }

    await reconcileExpiredInlineCardReservations(
      input.applications.map((application) => application.invoiceId),
    );
    const result = await db.transaction(async (tx) => {
      if (input.idempotencyKey) {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${input.labOrganizationId}), hashtext(${input.idempotencyKey}))`,
        );
      }
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${input.labOrganizationId}), hashtext(${input.providerOrganizationId}))`,
      );
      if (input.idempotencyKey) {
        const [existing] = await tx
          .select()
          .from(statementPaymentSessions)
          .where(and(
            eq(statementPaymentSessions.labOrganizationId, input.labOrganizationId),
            eq(statementPaymentSessions.idempotencyKey, input.idempotencyKey),
          ))
          .for("update");
        if (existing) {
          if (existing.requestFingerprint !== requestFingerprint) {
            throw new HttpError(409, "This idempotency key was already used for a different payment.");
          }
          return {
            session: existing,
            duplicate: true,
            invoiceIds: input.applications.map((application) => application.invoiceId),
          };
        }
      }

      // Statement-led and invoice-led receipts share this one writer. The
      // only difference is where the set of payable invoices comes from: a
      // sent statement, or the account's own outstanding invoices.
      let statement: typeof practiceStatements.$inferSelect | null = null;
      if (input.statementId) {
        const [row] = await tx
          .select()
          .from(practiceStatements)
          .where(eq(practiceStatements.id, input.statementId))
          .for("update");
        if (
          !row ||
          row.labOrganizationId !== input.labOrganizationId ||
          row.providerOrganizationId !== input.providerOrganizationId
        ) {
          throw new HttpError(404, "Statement not found for this customer account.");
        }
        statement = row;
        await assertStatementCurrentlyEligible(tx as unknown as typeof db, {
          labOrganizationId: input.labOrganizationId,
          providerOrganizationId: input.providerOrganizationId,
          statementId: input.statementId,
        });
      }
      const eligibleStatementInvoicesSnapshot = statement
        ? await eligibleStatementInvoices(tx as unknown as typeof db, {
            labOrganizationId: input.labOrganizationId,
            providerOrganizationId: input.providerOrganizationId,
            selectedStatement: statement,
          })
        : {
            invoiceIds: new Set<string>(),
            invoiceAmounts: new Map<string, string>(),
            invoiceDetails: new Map<string, StatementInvoiceDetail>(),
          };
      const allowedInvoiceIds = eligibleStatementInvoicesSnapshot.invoiceIds;
      const selectedStatementInvoiceAmounts =
        eligibleStatementInvoicesSnapshot.invoiceAmounts;
      const selectedStatementInvoiceDetails =
        eligibleStatementInvoicesSnapshot.invoiceDetails;
      const requestedInvoiceIds = input.applications.map(
        (application) => application.invoiceId,
      );
      if (
        statement &&
        requestedInvoiceIds.some((invoiceId) => !allowedInvoiceIds.has(invoiceId))
      ) {
        throw new HttpError(
          400,
          "Every invoice application must belong to the selected statement.",
        );
      }
      const invoiceRows = await tx
        .select()
        .from(invoices)
        .where(and(
          eq(invoices.labOrganizationId, input.labOrganizationId),
          eq(invoices.providerOrganizationId, input.providerOrganizationId),
          isNull(invoices.deletedAt),
        ))
        .orderBy(asc(invoices.issuedAt), asc(invoices.createdAt), asc(invoices.id))
        .for("update");
      const invoiceById = new Map(invoiceRows.map((invoice) => [invoice.id, invoice]));
      const invoiceBalanceBefore = new Map(
        invoiceRows.map((invoice) => [invoice.id, Number(invoice.balanceDue)]),
      );
      for (const invoiceId of requestedInvoiceIds) {
        const invoice = invoiceById.get(invoiceId);
        if (!invoice || !OPEN_STATUSES.has(invoice.status)) {
          throw new HttpError(400, "One or more invoices cannot accept a payment.");
        }
        assertInvoiceDoctorScope(
          invoice,
          input.doctorIdentity ?? null,
          input.doctorName ?? null,
        );
      }
      const creditRows = input.existingCreditAmount > 0
        ? await tx.select().from(customerCredits).where(and(
          eq(customerCredits.labOrganizationId, input.labOrganizationId),
          eq(customerCredits.providerOrganizationId, input.providerOrganizationId),
          isNull(customerCredits.reversedAt),
          gt(customerCredits.remainingAmount, "0"),
          customerCreditIsNotReservedForReversal(),
        )).orderBy(asc(customerCredits.createdAt), asc(customerCredits.id)).for("update")
        : [];
      const availableCredit = creditRows.reduce(
        (sum, credit) => sum + Number(credit.remainingAmount),
        0,
      );
      if (input.existingCreditAmount > availableCredit + 0.005) {
        throw new HttpError(400, "Requested customer credit exceeds the available balance.");
      }
      const creditAllocations: Array<{ creditId: string; invoiceId: string; amount: number }> = [];
      const requestedCredit = new Map(
        input.applications
          .filter((application) => application.creditAmount > 0)
          .map((application) => [application.invoiceId, application.creditAmount]),
      );
      let creditRemaining = input.existingCreditAmount;
      const creditCapacity = new Map(
        creditRows.map((credit) => [credit.id, Number(credit.remainingAmount)]),
      );
      const allocateCredit = (creditId: string, invoiceId: string, amount: number) => {
        const invoice = invoiceById.get(invoiceId)!;
        if (!OPEN_STATUSES.has(invoice.status)) return 0;
        const applied = Math.min(
          amount,
          creditCapacity.get(creditId) ?? 0,
          Number(invoice.balanceDue),
        );
        if (applied <= 0.005) return 0;
        invoice.balanceDue = money(Number(invoice.balanceDue) - applied);
        invoice.status = Number(invoice.balanceDue) <= 0.005 ? "paid" : "partially_paid";
        creditCapacity.set(creditId, (creditCapacity.get(creditId) ?? 0) - applied);
        creditAllocations.push({ creditId, invoiceId, amount: applied });
        return applied;
      };
      for (const credit of creditRows) {
        for (const [invoiceId, requested] of requestedCredit) {
          if (creditRemaining <= 0.005) break;
          const applied = allocateCredit(
            credit.id,
            invoiceId,
            Math.min(requested, creditRemaining),
          );
          requestedCredit.set(invoiceId, requested - applied);
          creditRemaining -= applied;
        }
      }
      if ([...requestedCredit.values()].some((amount) => amount > 0.005)) {
        throw new HttpError(400, "Requested customer credit exceeds an invoice balance.");
      }
      for (const credit of creditRows) {
        for (const invoice of invoiceRows) {
          if (creditRemaining <= 0.005) break;
          const applied = allocateCredit(credit.id, invoice.id, creditRemaining);
          creditRemaining -= applied;
        }
      }
      if (creditRemaining > 0.005) {
        throw new HttpError(400, "Customer credit cannot be applied because no eligible invoice balance remains.");
      }
      const sessionId = randomUUID();
      const stableReceiptNumber = receiptNumber(sessionId, paymentDate);
      const [session] = await tx
        .insert(statementPaymentSessions)
        .values({
          id: sessionId,
          labOrganizationId: input.labOrganizationId,
          providerOrganizationId: input.providerOrganizationId,
          doctorIdentity:
            input.doctorIdentity ??
            normalizeLegacyDoctorName(input.doctorName ?? null),
          doctorDisplayName: input.doctorName?.trim() || null,
          statementId: statement?.id ?? null,
          idempotencyKey: input.idempotencyKey ?? null,
          requestFingerprint,
          receiptNumber: stableReceiptNumber,
          receivedAmount: money(input.receivedAmount),
          appliedAmount: money(totalApplied + input.existingCreditAmount),
          customerCreditAmount: money(input.receivedAmount - totalApplied),
          accountBalanceAfter: "0.00",
          paymentMethod: input.paymentMethod,
          checkNumber: input.checkNumber?.trim() || null,
          cardLast4: input.cardLast4 ?? null,
          memo: input.memo?.trim() || null,
          paymentDate,
          customerName: provider.displayName || provider.name,
          customerEmail:
            input.customerEmail?.trim() || provider.billingEmail || null,
          customerAddressJson: {
            addressLine1: provider.addressLine1,
            addressLine2: provider.addressLine2,
            city: provider.city,
            state: provider.state,
            zip: provider.zip,
            phone: provider.phone,
            accountNumber: provider.accountNumber,
          },
          labName: lab.displayName || lab.name,
          receiptLogoBase64: receiptLogo?.content.toString("base64") ?? null,
          receiptLogoContentType: receiptLogo?.contentType ?? null,
          status: "undeposited",
          createdByUserId: callerId,
        })
        .returning();

      const receiptAmounts = new Map<string, number>();
      const updatedInvoices = [];
      const insertedPayments = [];
      for (const application of input.applications) {
        const invoice = invoiceById.get(application.invoiceId)!;
        const before = Number(invoice.balanceDue);
        if (application.amount > before + 0.005) {
          throw new HttpError(400, `Payment exceeds the balance on invoice ${invoice.invoiceNumber}.`);
        }
        if (application.amount <= 0.005) continue;
        const after = before - application.amount;
        const [payment] = await tx.insert(payments).values({
          invoiceId: invoice.id,
          paymentSessionId: session.id,
          amount: money(application.amount),
          paymentMethod: input.paymentMethod,
          referenceNumber: input.checkNumber?.trim() || input.referenceNumber?.trim() || input.cardLast4 || null,
          paidAt: paymentDate,
          recordedByUserId: callerId,
        }).returning();
        insertedPayments.push(payment);
        invoice.balanceDue = money(after);
        invoice.status = after <= 0.005 ? "paid" : "partially_paid";
        const [updated] = await tx.update(invoices).set({
          balanceDue: invoice.balanceDue,
          status: invoice.status,
          updatedByUserId: callerId,
          updatedAt: new Date(),
        }).where(eq(invoices.id, invoice.id)).returning();
        updatedInvoices.push(updated);
        receiptAmounts.set(invoice.id, (receiptAmounts.get(invoice.id) ?? 0) + application.amount);
      }
      const creditById = new Map<string, number>();
      for (const allocation of creditAllocations) {
        creditById.set(allocation.creditId, (creditById.get(allocation.creditId) ?? 0) + allocation.amount);
        receiptAmounts.set(allocation.invoiceId, (receiptAmounts.get(allocation.invoiceId) ?? 0) + allocation.amount);
        await tx.insert(workspaceDb.customerCreditApplications).values({
          customerCreditId: allocation.creditId,
          paymentSessionId: session.id,
          invoiceId: allocation.invoiceId,
          amount: money(allocation.amount),
        });
      }
      for (const credit of creditRows) {
        const used = creditById.get(credit.id) ?? 0;
        if (used > 0) {
          await tx.update(customerCredits).set({
            remainingAmount: money(Number(credit.remainingAmount) - used),
            updatedAt: new Date(),
          }).where(eq(customerCredits.id, credit.id));
        }
      }
      for (const [invoiceId, amount] of receiptAmounts) {
        const invoice = invoiceById.get(invoiceId)!;
        const statementDetail = selectedStatementInvoiceDetails.get(invoiceId);
        if (creditAllocations.some((allocation) => allocation.invoiceId === invoiceId)) {
          const [updated] = await tx.update(invoices).set({
            balanceDue: invoice.balanceDue,
            status: invoice.status,
            updatedByUserId: callerId,
            updatedAt: new Date(),
          }).where(eq(invoices.id, invoiceId)).returning();
          updatedInvoices.push(updated);
        }
        await tx.insert(statementPaymentApplications).values({
          paymentSessionId: session.id,
          invoiceId,
          invoiceNumber: statementDetail?.invoiceNumber ?? invoice.invoiceNumber,
          patientName: statementDetail?.patientName ?? patientName(invoice),
          invoiceTotal: invoice.total,
          statementInvoiceAmount:
            selectedStatementInvoiceAmounts.get(invoiceId) ?? null,
          amount: money(amount),
          invoiceBalanceBefore: money(invoiceBalanceBefore.get(invoiceId) ?? 0),
          invoiceBalanceAfter: invoice.balanceDue,
        });
      }
      const unapplied = input.receivedAmount - totalApplied;
      if (unapplied > 0.005) {
        await tx.insert(customerCredits).values({
          labOrganizationId: input.labOrganizationId,
          providerOrganizationId: input.providerOrganizationId,
          paymentSessionId: session.id,
          amount: money(unapplied),
          remainingAmount: money(unapplied),
          note: input.memo?.trim() || "Unapplied statement payment",
          createdByUserId: callerId,
        });
      }
      const [bankTransaction] = input.receivedAmount > 0
        ? await tx.insert(bankTransactions).values({
          labOrganizationId: input.labOrganizationId,
          bankAccountId: ufAccount!.id,
          txnDate: paymentDate,
          type: "deposit",
          checkNumber: input.checkNumber?.trim() || null,
          payee: provider.displayName || provider.name,
          memo: input.memo?.trim() || null,
          debitAmount: "0.00",
          creditAmount: money(input.receivedAmount),
          netAmount: money(input.receivedAmount),
          cleared: false,
          status: "posted",
          source: "customer_payment",
          categoryId: arCategoryId,
          createdByUserId: callerId,
        }).returning()
        : [null];
      for (const invoice of new Map(updatedInvoices.map((row) => [row.id, row])).values()) {
        if (!bankTransaction) break;
        await tx.insert(bankTransactionInvoices).values({
          bankTransactionId: bankTransaction.id,
          invoiceId: invoice.id,
        });
      }
      if (bankTransaction && insertedPayments.length) {
        await tx.update(payments)
          .set({ bankTransactionId: bankTransaction.id })
          .where(inArray(payments.id, insertedPayments.map((payment) => payment.id)));
      }
      const accountBalance = await calculateAccountBalance(
        tx,
        input.labOrganizationId,
        input.providerOrganizationId,
      );
      const [completed] = await tx.update(statementPaymentSessions).set({
        bankTransactionId: bankTransaction?.id ?? null,
        accountBalanceAfter: accountBalance.currentBalance,
        updatedAt: new Date(),
      }).where(eq(statementPaymentSessions.id, session.id)).returning();
      return {
        session: completed,
        duplicate: false,
        invoiceIds: [
          ...input.applications.map((application) => application.invoiceId),
          ...creditAllocations.map((allocation) => allocation.invoiceId),
        ],
      };
    }).catch((error: unknown): never => {
      if (error instanceof HttpError) throw error;
      wrapDbError(error, {
        duplicate: "This payment has already been recorded.",
        fallback: "Failed to record payment.",
      });
    });

    if (!result.duplicate) {
      await deliverPaymentNotifications({
        origin: "lab",
        sourceType: "statement_payment_session",
        sourceId: result.session.id,
        labOrganizationId: input.labOrganizationId,
        providerOrganizationId: input.providerOrganizationId,
        amount: result.session.receivedAmount,
        invoiceIds: result.invoiceIds,
        paymentMethod: input.paymentMethod,
        customerCreditAmount: result.session.customerCreditAmount,
      });
      await writeAuditLog({
        req,
        organizationId: input.labOrganizationId,
        action: "statement_payment_recorded",
        entityType: "statement_payment_session",
        entityId: result.session.id,
        metadataJson: {
          statementId: input.statementId,
          providerOrganizationId: input.providerOrganizationId,
          receivedAmount: result.session.receivedAmount,
          appliedAmount: result.session.appliedAmount,
          customerCreditAmount: result.session.customerCreditAmount,
        },
      });
    }
    return ok(
      res,
      await loadPaymentSessionData(result.session.id),
      result.duplicate ? 200 : 201,
    );
  }),
);

/**
 * Receive-Payments saved-card path. Stripe's reservation/confirmation service
 * is the only component that can settle card allocations; this endpoint then
 * durably creates the matching receipt and Undeposited Funds event. It never
 * accepts card data, and a non-successful/ambiguous confirmation returns
 * before this accounting session is written.
 */
const savedCardPaymentHandler = asyncHandler(
  async (req, res) => {
    const callerId = uid(req);
    const trustedInlineWebhook =
      (req as Record<PropertyKey, unknown>)[TRUSTED_INLINE_WEBHOOK] === true;
    const parsedInput = createPaymentSessionSchema.parse(req.body);
    const explicitCreditAmount = parsedInput.applications.reduce(
      (sum, application) => sum + application.creditAmount,
      0,
    );
    const input = {
      ...parsedInput,
      existingCreditAmount: Math.max(
        parsedInput.existingCreditAmount,
        explicitCreditAmount,
      ),
    };
    if (input.paymentMethod !== "card") {
      throw new HttpError(400, "Use this endpoint only for saved-card payments.");
    }
    if (
      new Set(input.applications.map((application) => application.invoiceId))
        .size !== input.applications.length
    ) {
      throw new HttpError(400, "Each invoice may only be allocated once.");
    }
    const total = input.applications.reduce((sum, item) => sum + item.amount, 0);
    if (total > input.receivedAmount + 0.005 || total <= 0) {
      throw new HttpError(400, "Saved-card invoice applications cannot exceed the card amount.");
    }
    if (!input.idempotencyKey) {
      throw new HttpError(400, "An idempotency key is required for saved-card payments.");
    }
    const cardIdempotencyKey = input.idempotencyKey;
    if (!trustedInlineWebhook) {
      await requireAnyRole(callerId, input.labOrganizationId, ADMIN_ROLES);
    }
    // Keep the provider-account serialization boundary alive across the
    // processor call and the final local receipt transaction. Ordinary
    // payments use the same advisory key transactionally and therefore wait.
    const providerLock = await acquireProviderAccountLock(
      input.labOrganizationId,
      input.providerOrganizationId,
    );
    try {
    const cardStatementId = input.statementId ?? null;
    const [statement, provider, lab, ufAccount] = await Promise.all([
      cardStatementId
        ? db.query.practiceStatements.findFirst({ where: eq(practiceStatements.id, cardStatementId) })
        : Promise.resolve(undefined),
      db.query.organizations.findFirst({ where: eq(organizations.id, input.providerOrganizationId) }),
      db.query.organizations.findFirst({ where: eq(organizations.id, input.labOrganizationId) }),
      db.query.bankAccounts.findFirst({ where: and(eq(bankAccounts.labOrganizationId, input.labOrganizationId), eq(bankAccounts.accountType, "undeposited_funds")) }),
    ]);
    if (cardStatementId && (!statement ||
      statement.labOrganizationId !== input.labOrganizationId ||
      statement.providerOrganizationId !== input.providerOrganizationId)) {
      throw new HttpError(404, "Statement not found for this customer account.");
    }
    if (!provider || provider.type !== "provider" ||
      (!trustedInlineWebhook &&
        provider.parentLabOrganizationId !== input.labOrganizationId) ||
      !lab || lab.type !== "lab") {
      throw new HttpError(404, "Customer account not found for this lab.");
    }
    if (!ufAccount) throw new HttpError(422, "No Undeposited Funds account found for this lab.");
    // Invoice-led receipts have no statement snapshot; the receipt then falls
    // back to the invoices' own amounts and details, which is what these maps
    // being empty means downstream.
    const eligibleStatementInvoicesSnapshot = statement
      ? await eligibleStatementInvoices(db, {
          labOrganizationId: input.labOrganizationId,
          providerOrganizationId: input.providerOrganizationId,
          selectedStatement: statement,
        })
      : {
          invoiceIds: new Set<string>(),
          invoiceAmounts: new Map<string, string>(),
          invoiceDetails: new Map<string, StatementInvoiceDetail>(),
        };
    if (statement && !trustedInlineWebhook &&
        input.applications.some(
          (item) => !eligibleStatementInvoicesSnapshot.invoiceIds.has(item.invoiceId),
        )) {
      throw new HttpError(400, "Every invoice application must belong to the selected statement.");
    }
    const fingerprint = input.paymentIntentId
      ? inlineCardFingerprint(inlineCardPrepareSchema.parse({
          labOrganizationId: input.labOrganizationId,
          providerOrganizationId: input.providerOrganizationId,
          doctorIdentity: input.doctorIdentity,
          doctorName: input.doctorName,
          statementId: input.statementId,
          receivedAmount: input.receivedAmount,
          existingCreditAmount: input.existingCreditAmount,
          paymentDate: input.paymentDate,
          paymentMethod: "card",
          memo: input.memo,
          customerEmail: input.customerEmail,
          idempotencyKey: input.idempotencyKey,
          savePaymentMethod: input.savePaymentMethod,
          applications: input.applications,
        }))
      : createHash("sha256").update(JSON.stringify({
          labOrganizationId: input.labOrganizationId,
          providerOrganizationId: input.providerOrganizationId,
          doctorIdentity: input.doctorIdentity ?? null,
          doctorName: input.doctorName ?? null,
          statementId: input.statementId,
          receivedAmount: money(input.receivedAmount),
          paymentMethod: "card",
          cardLast4: input.cardLast4,
          existingCreditAmount: money(input.existingCreditAmount),
          applications: [...input.applications].sort((a, b) =>
            a.invoiceId.localeCompare(b.invoiceId)),
        })).digest("hex");
    const [lockedPrior] = await db.select().from(statementPaymentSessions).where(and(
      eq(statementPaymentSessions.labOrganizationId, input.labOrganizationId),
      eq(statementPaymentSessions.idempotencyKey, cardIdempotencyKey),
    ));
    if (lockedPrior) {
      if (lockedPrior.requestFingerprint !== fingerprint) {
        throw new HttpError(409, "This idempotency key was already used for a different payment.");
      }
      return ok(res, await loadPaymentSessionData(lockedPrior.id));
    }
    const [prior] = await db.select().from(statementPaymentSessions).where(and(
      eq(statementPaymentSessions.labOrganizationId, input.labOrganizationId),
      eq(statementPaymentSessions.idempotencyKey, cardIdempotencyKey),
    ));
    if (prior) {
      if (prior.requestFingerprint !== fingerprint) throw new HttpError(409, "This idempotency key was already used for a different payment.");
      return ok(res, await loadPaymentSessionData(prior.id));
    }
    const [existingReservation] = await db
      .select({ id: providerPaymentCheckouts.id })
      .from(providerPaymentCheckouts)
      .where(
        and(
          eq(
            providerPaymentCheckouts.providerOrganizationId,
            input.providerOrganizationId,
          ),
          eq(providerPaymentCheckouts.clientRequestId, cardIdempotencyKey),
        ),
      )
      .limit(1);
    if (!existingReservation) {
      if (cardStatementId) {
        await assertStatementCurrentlyEligible(db, {
          labOrganizationId: input.labOrganizationId,
          providerOrganizationId: input.providerOrganizationId,
          statementId: cardStatementId,
        });
      } else if (!trustedInlineWebhook) {
        await assertInvoicesPayableNow(db, {
          labOrganizationId: input.labOrganizationId,
          providerOrganizationId: input.providerOrganizationId,
          invoiceIds: input.applications
            .filter((item) => item.amount > 0)
            .map((item) => item.invoiceId),
        });
      }
    }
    // Fail stale credit/combined-capacity requests before creating a processor
    // reservation. Provider settlement owns monetary locking; this preflight
    // prevents a credit race from becoming a post-charge local failure.
    if (input.existingCreditAmount > 0) {
      await db.transaction(async (tx) => {
        const rows = await tx.select().from(invoices).where(and(
          eq(invoices.labOrganizationId, input.labOrganizationId),
          eq(invoices.providerOrganizationId, input.providerOrganizationId),
          inArray(invoices.id, input.applications.map((item) => item.invoiceId)),
          isNull(invoices.deletedAt), ne(invoices.status, "void"), finalizedInvoiceSql(),
        )).for("update");
        const byId = new Map(rows.map((row) => [row.id, row]));
        const credits = await tx.select().from(customerCredits).where(and(
          eq(customerCredits.labOrganizationId, input.labOrganizationId),
          eq(customerCredits.providerOrganizationId, input.providerOrganizationId),
           isNull(customerCredits.reversedAt), gt(customerCredits.remainingAmount, "0"),
           customerCreditIsNotReservedForReversal(),
        )).for("update");
        const available = credits.reduce((sum, row) => sum + Number(row.remainingAmount), 0);
        if (input.existingCreditAmount > available + 0.005) {
          throw new HttpError(409, "Customer credit changed; refresh and retry.");
        }
        const creditByInvoice = new Map<string, number>();
        for (const item of input.applications) {
          if (item.creditAmount > 0) {
            creditByInvoice.set(item.invoiceId,
              (creditByInvoice.get(item.invoiceId) ?? 0) + item.creditAmount);
          }
        }
        for (const item of input.applications) {
          const invoice = byId.get(item.invoiceId);
          if (!invoice) throw new HttpError(409, "An invoice changed; refresh and retry.");
          const postMoney = Number(invoice.balanceDue) - item.amount;
          if (postMoney < -0.005 ||
            (creditByInvoice.get(item.invoiceId) ?? 0) > postMoney + 0.005) {
            throw new HttpError(409, "Invoice capacity changed; refresh and retry.");
          }
        }
      });
    }
    const stripe = await getUncachableStripeClient();
    if (!stripe) throw new HttpError(503, "Stripe card payments are not configured.");
    const reservation = await reserveLabCardCharge(
      input.labOrganizationId,
      input.providerOrganizationId,
      input.applications
        .filter((item) => item.amount > 0)
        .map((item) => ({ invoiceId: item.invoiceId, amount: Math.round(item.amount * 100) })),
      cardIdempotencyKey,
      callerId,
      Math.round(input.receivedAmount * 100),
      true,
      input.savePaymentMethod,
    );
    // Confirmation is an authenticated reconciliation request, not an
    // accounting shortcut. Always retrieve and verify the persisted intent,
    // including when a webhook already marked the checkout succeeded.
    let verifiedInlineIntent: import("stripe").default.PaymentIntent | null = null;
    let verifiedInlinePaymentMethodId: string | null = null;
    if (input.paymentIntentId) {
      if (reservation.checkout.stripePaymentIntentId !== input.paymentIntentId) {
        throw new HttpError(409, "Payment intent does not match this checkout.");
      }
      verifiedInlineIntent = await stripe.paymentIntents.retrieve(input.paymentIntentId);
      if (verifiedInlineIntent.metadata?.providerPaymentCheckoutId !== reservation.checkout.id ||
          verifiedInlineIntent.metadata?.receivePaymentFingerprint !== fingerprint) {
        throw new HttpError(409, "Payment intent metadata does not match this payment draft.");
      }
      if (verifiedInlineIntent.status !== "succeeded") {
        return ok(res, {
          checkoutId: reservation.checkout.id, status: verifiedInlineIntent.status,
          totalAmount: reservation.checkout.totalAmount,
        });
      }
      const verifiedMethodId = typeof verifiedInlineIntent.payment_method === "string"
        ? verifiedInlineIntent.payment_method
        : verifiedInlineIntent.payment_method?.id;
      if (!verifiedMethodId) throw new HttpError(409, "Stripe did not return a card payment method.");
      verifiedInlinePaymentMethodId = verifiedMethodId;
      const verifiedMethod = await stripe.paymentMethods.retrieve(verifiedMethodId);
      if (verifiedMethod.type !== "card" || !verifiedMethod.card) {
        throw new HttpError(409, "Stripe did not return a valid card payment method.");
      }
      input.cardLast4 = verifiedMethod.card.last4;
    }
    if (reservation.checkout.status === "pending") {
      if (input.paymentIntentId) {
        if (reservation.checkout.stripePaymentIntentId !== input.paymentIntentId) {
          throw new HttpError(409, "Payment intent does not match this checkout.");
        }
        const intent = verifiedInlineIntent ?? await stripe.paymentIntents.retrieve(input.paymentIntentId);
        if (intent.metadata?.providerPaymentCheckoutId !== reservation.checkout.id ||
            intent.metadata?.receivePaymentFingerprint !== fingerprint) {
          throw new HttpError(409, "Payment intent metadata does not match this payment draft.");
        }
        if (intent.status !== "succeeded") {
          return ok(res, {
            checkoutId: reservation.checkout.id, status: intent.status,
            totalAmount: reservation.checkout.totalAmount,
          });
        }
        const paymentMethodId = typeof intent.payment_method === "string"
          ? intent.payment_method
          : intent.payment_method?.id;
        if (!paymentMethodId) {
          throw new HttpError(409, "Stripe did not return a card payment method.");
        }
        const paymentMethod = await stripe.paymentMethods.retrieve(paymentMethodId);
        if (paymentMethod.type !== "card" || !paymentMethod.card) {
          throw new HttpError(409, "Stripe did not return a valid card payment method.");
        }
        input.cardLast4 = paymentMethod.card.last4;
        await settleProviderPaymentCheckout(
          reservation.checkout.id, intent.id,
          typeof intent.latest_charge === "string" ? intent.latest_charge : intent.latest_charge?.id ?? null,
          true,
        );
      } else {
        const outcome = await confirmReservedLabCardCharge(
          stripe, reservation.checkout, reservation.allocations, true,
        );
        if (outcome.status !== "succeeded") {
          if (outcome.status === "pending") {
            const guidance = pendingLabCardReservationGuidance({
              stripePaymentIntentId: reservation.checkout.stripePaymentIntentId,
              failureReason: outcome.failureReason,
            });
            throw new HttpError(409, guidance.message, guidance.details);
          }
          throw new HttpError(402, outcome.failureReason ?? "Card payment was not completed.");
        }
      }
    } else if (reservation.checkout.status !== "succeeded") {
      throw new HttpError(402, reservation.checkout.failureReason ?? "Card payment was not completed.");
    }
    // Saving is an independently replayable post-confirmation requirement.
    // Reconcile it even when a webhook settled the checkout before this call,
    // or when an earlier attempt failed after processor settlement.
    if (input.paymentIntentId && reservation.checkout.savePaymentMethod) {
      const intent = verifiedInlineIntent!;
      const customerId = typeof intent.customer === "string"
        ? intent.customer
        : intent.customer?.id;
      if (!customerId || !verifiedInlinePaymentMethodId) {
        throw new HttpError(409, "Stripe did not attach the saved card to the customer.");
      }
      await stripe.customers.update(customerId, {
        invoice_settings: { default_payment_method: verifiedInlinePaymentMethodId },
      });
      await db.update(providerPaymentCustomers).set({ authorizedPaymentMethodId: verifiedInlinePaymentMethodId })
        .where(eq(providerPaymentCustomers.providerOrganizationId, input.providerOrganizationId));
      await refreshSharedCardSummary(input.providerOrganizationId, stripe);
    }
    const paymentDate = input.paymentDate ? new Date(input.paymentDate) : new Date();
    if (Number.isNaN(paymentDate.getTime())) throw new HttpError(400, "Invalid payment date.");
    const completed = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${input.labOrganizationId}), hashtext(${cardIdempotencyKey}))`);
      const [replay] = await tx.select().from(statementPaymentSessions).where(and(
        eq(statementPaymentSessions.labOrganizationId, input.labOrganizationId),
        eq(statementPaymentSessions.idempotencyKey, cardIdempotencyKey),
      )).for("update");
      if (replay) {
        if (replay.requestFingerprint !== fingerprint) throw new HttpError(409, "This idempotency key was already used for a different payment.");
        return replay;
      }
       const invoiceRows = await tx.select().from(invoices)
         .where(and(
           eq(invoices.labOrganizationId, input.labOrganizationId),
           eq(invoices.providerOrganizationId, input.providerOrganizationId),
           isNull(invoices.deletedAt),
           ne(invoices.status, "void"),
           finalizedInvoiceSql(),
         ))
         .orderBy(asc(invoices.issuedAt), asc(invoices.createdAt), asc(invoices.id))
         .for("update");
       const selectedStatementInvoiceAmounts =
         eligibleStatementInvoicesSnapshot.invoiceAmounts;
       const selectedStatementInvoiceDetails =
         eligibleStatementInvoicesSnapshot.invoiceDetails;
       const requestedIds = new Set(input.applications.map((item) => item.invoiceId));
       if ([...requestedIds].some((id) => !invoiceRows.some((row) => row.id === id))) {
         throw new HttpError(409, "A charged invoice is unavailable for receipt reconciliation.");
       }
       for (const invoice of invoiceRows.filter((row) => requestedIds.has(row.id))) {
         assertInvoiceDoctorScope(
           invoice,
           input.doctorIdentity ?? null,
           input.doctorName ?? null,
         );
       }
        const scopedInvoiceRows = input.doctorIdentity || input.doctorName
          ? invoiceRows.filter((invoice) =>
              invoiceMatchesSelectedDoctor(
                invoice,
                input.doctorIdentity ?? null,
                input.doctorName ?? null,
              ))
          : invoiceRows;
       const creditRows = input.existingCreditAmount > 0
         ? await tx.select().from(customerCredits).where(and(
           eq(customerCredits.labOrganizationId, input.labOrganizationId),
           eq(customerCredits.providerOrganizationId, input.providerOrganizationId),
            isNull(customerCredits.reversedAt), gt(customerCredits.remainingAmount, "0"),
            customerCreditIsNotReservedForReversal(),
         )).orderBy(asc(customerCredits.createdAt), asc(customerCredits.id)).for("update")
         : [];
       const availableCredit = creditRows.reduce(
         (sum, credit) => sum + Number(credit.remainingAmount), 0,
       );
       if (input.existingCreditAmount > availableCredit + 0.005) {
         throw new HttpError(400, "Requested customer credit exceeds the available balance.");
       }
       const creditRemaining = input.existingCreditAmount;
       const creditAllocations: Array<{ creditId: string; invoiceId: string; amount: number }> = [];
       const requestedCredit = new Map(input.applications
         .filter((item) => item.creditAmount > 0)
         .map((item) => [item.invoiceId, item.creditAmount]));
       const applyCredit = (invoiceId: string, amount: number, creditId: string) => {
         const invoice = invoiceRows.find((row) => row.id === invoiceId)!;
          if (!OPEN_STATUSES.has(invoice.status)) return 0;
         const applied = Math.min(amount, Number(invoice.balanceDue));
         invoice.balanceDue = money(Number(invoice.balanceDue) - applied);
         invoice.status = Number(invoice.balanceDue) <= 0.005 ? "paid" : "partially_paid";
         creditAllocations.push({ creditId, invoiceId, amount: applied });
         return applied;
       };
       let creditLeft = creditRemaining;
       const sourceCapacity = new Map(
         creditRows.map((credit) => [credit.id, Number(credit.remainingAmount)]),
       );
       for (const credit of creditRows) {
         for (const [invoiceId, amount] of requestedCredit) {
           if (creditLeft <= 0.005) break;
           const applied = applyCredit(invoiceId,
             Math.min(amount, creditLeft, sourceCapacity.get(credit.id) ?? 0), credit.id);
           requestedCredit.set(invoiceId, amount - applied);
           creditLeft -= applied;
           sourceCapacity.set(credit.id,
             (sourceCapacity.get(credit.id) ?? 0) - applied);
         }
       }
       if ([...requestedCredit.values()].some((amount) => amount > 0.005)) {
         throw new HttpError(400, "Requested customer credit exceeds an invoice balance.");
       }
       if (creditLeft > 0.005) {
         for (const credit of creditRows) {
            for (const invoice of scopedInvoiceRows) {
             if (creditLeft <= 0.005) break;
             const applied = applyCredit(invoice.id,
               Math.min(creditLeft, sourceCapacity.get(credit.id) ?? 0), credit.id);
             creditLeft -= applied;
             sourceCapacity.set(credit.id,
               (sourceCapacity.get(credit.id) ?? 0) - applied);
           }
         }
       }
       if (creditLeft > 0.005) throw new HttpError(400, "Customer credit cannot be applied.");
      const sessionId = randomUUID();
      const [session] = await tx.insert(statementPaymentSessions).values({
        id: sessionId, labOrganizationId: input.labOrganizationId, providerOrganizationId: input.providerOrganizationId,
        doctorIdentity:
          input.doctorIdentity ?? normalizeLegacyDoctorName(input.doctorName ?? null),
        doctorDisplayName: input.doctorName?.trim() || null,
        statementId: input.statementId, idempotencyKey: cardIdempotencyKey, requestFingerprint: fingerprint,
        providerPaymentCheckoutId: reservation.checkout.id,
        receiptNumber: receiptNumber(sessionId, paymentDate), receivedAmount: money(input.receivedAmount),
         appliedAmount: money(total + input.existingCreditAmount),
         customerCreditAmount: money(input.receivedAmount - total),
         accountBalanceAfter: "0.00",
        paymentMethod: "card", cardLast4: input.cardLast4!, memo: input.memo?.trim() || null, paymentDate,
        customerName: provider.displayName || provider.name, customerEmail: input.customerEmail?.trim() || provider.billingEmail || null,
        customerAddressJson: { addressLine1: provider.addressLine1, addressLine2: provider.addressLine2, city: provider.city, state: provider.state, zip: provider.zip, phone: provider.phone, accountNumber: provider.accountNumber },
        labName: lab.displayName || lab.name, status: "undeposited", createdByUserId: callerId,
      }).returning();
       const unappliedCash = input.receivedAmount - total;
       if (unappliedCash > 0.005) {
         await tx.insert(customerCredits).values({
           labOrganizationId: input.labOrganizationId,
           providerOrganizationId: input.providerOrganizationId,
           paymentSessionId: session.id,
           amount: money(unappliedCash),
           remainingAmount: money(unappliedCash),
           note: input.memo?.trim() || "Unapplied card payment",
           createdByUserId: callerId,
         });
       }
      for (const item of input.applications) {
        const invoice = invoiceRows.find((row) => row.id === item.invoiceId)!;
         const statementDetail = selectedStatementInvoiceDetails.get(invoice.id);
         const creditForInvoice = creditAllocations
           .filter((allocation) => allocation.invoiceId === invoice.id)
           .reduce((sum, allocation) => sum + allocation.amount, 0);
         const before = Number(invoice.balanceDue) + item.amount + creditForInvoice;
        await tx.insert(statementPaymentApplications).values({
          paymentSessionId: session.id, invoiceId: invoice.id,
          invoiceNumber: statementDetail?.invoiceNumber ?? invoice.invoiceNumber,
           patientName: statementDetail
             ? statementDetail.patientName
             : patientName(invoice),
           invoiceTotal: invoice.total,
           statementInvoiceAmount:
             selectedStatementInvoiceAmounts.get(invoice.id) ?? null,
           amount: money(item.amount + creditForInvoice),
           invoiceBalanceBefore: money(before), invoiceBalanceAfter: invoice.balanceDue,
        });
      }
       const consumedByCredit = new Map<string, number>();
       for (const allocation of creditAllocations) {
         const invoice = invoiceRows.find((row) => row.id === allocation.invoiceId)!;
         await tx.insert(workspaceDb.customerCreditApplications).values({
           customerCreditId: allocation.creditId, paymentSessionId: session.id,
           invoiceId: invoice.id, amount: money(allocation.amount),
         });
         consumedByCredit.set(allocation.creditId,
           (consumedByCredit.get(allocation.creditId) ?? 0) + allocation.amount);
       }
       for (const [creditId, consumed] of consumedByCredit) {
         const credit = creditRows.find((row) => row.id === creditId)!;
         await tx.update(customerCredits).set({
           remainingAmount: money(Number(credit.remainingAmount) - consumed),
           updatedAt: new Date(),
         }).where(eq(customerCredits.id, creditId));
       }
       for (const invoice of invoiceRows.filter((row) =>
         creditAllocations.some((allocation) => allocation.invoiceId === row.id))) {
         await tx.update(invoices).set({
           balanceDue: invoice.balanceDue,
           status: invoice.status,
           updatedByUserId: callerId,
           updatedAt: new Date(),
         }).where(eq(invoices.id, invoice.id));
       }
      // Settlement inserted these payment rows before this accounting
      // transaction ran, so their paidAt carries the processor settlement
      // instant. Dated AR reads paidAt, so it has to agree with the receipt,
      // the session, and the bank entry — all of which use the selected date.
      await tx.update(payments)
        .set({ paidAt: paymentDate })
        .where(eq(payments.providerPaymentCheckoutId, reservation.checkout.id));
      const [bankTransaction] = await tx.insert(bankTransactions).values({
        labOrganizationId: input.labOrganizationId, bankAccountId: ufAccount.id, txnDate: paymentDate, type: "deposit",
        payee: provider.displayName || provider.name, memo: input.memo?.trim() || null, debitAmount: "0.00",
        creditAmount: money(input.receivedAmount), netAmount: money(input.receivedAmount), cleared: false,
        status: "posted", source: "customer_payment", createdByUserId: callerId,
      }).returning();
      await tx.insert(bankTransactionInvoices).values(input.applications.map((item) => ({ bankTransactionId: bankTransaction.id, invoiceId: item.invoiceId })));
      const balance = await calculateAccountBalance(tx, input.labOrganizationId, input.providerOrganizationId);
      const [saved] = await tx.update(statementPaymentSessions).set({
        bankTransactionId: bankTransaction.id, accountBalanceAfter: balance.currentBalance, updatedAt: new Date(),
      }).where(eq(statementPaymentSessions.id, session.id)).returning();
      return saved;
    });
    await writeAuditLog({ req, organizationId: input.labOrganizationId, action: "statement_card_payment_recorded", entityType: "statement_payment_session", entityId: completed.id, metadataJson: { statementId: input.statementId, providerPaymentCheckoutId: reservation.checkout.id } });
    const responseData = await loadPaymentSessionData(completed.id);
    return ok(res, responseData, 201);
    } finally {
      await providerLock.release();
    }
  },
);

router.post("/payment-sessions/card", savedCardPaymentHandler);
// New-card confirmation intentionally uses the exact saved-card accounting
// completion above; paymentIntentId switches only the processor verification
// branch and never changes receipt/accounting semantics.
router.post("/payment-sessions/card/confirm", savedCardPaymentHandler);

/**
 * Stripe webhook reconciliation entrypoint for inline drafts. The draft is
 * loaded from the checkout rather than reconstructed from webhook metadata;
 * this makes webhook-first delivery and process/browser recovery use exactly
 * the same idempotent accounting path as an explicit confirm.
 */
export async function finalizeInlinePaymentIntentFromWebhook(
  checkoutId: string,
  paymentIntentId: string,
) {
  const [checkout] = await db.select().from(providerPaymentCheckouts)
    .where(eq(providerPaymentCheckouts.id, checkoutId)).limit(1);
  if (!checkout?.inlineDraftJson || !checkout.clientRequestId) return null;
  const draft = checkout.inlineDraftJson as Record<string, unknown>;
  const body = {
    ...draft,
    idempotencyKey: checkout.clientRequestId,
    paymentIntentId,
    paymentMethod: "card",
  };
  return new Promise<unknown>((resolve, reject) => {
    const response: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      json(value: unknown) { resolve(value); return this; },
    };
    savedCardPaymentHandler(
      {
        [TRUSTED_INLINE_WEBHOOK]: true,
        auth: { userId: checkout.initiatedByUserId },
        body,
        ip: "stripe-webhook",
        headers: {},
        get: () => undefined,
      } as any,
      response,
      (error: unknown) => error ? reject(error) : resolve(undefined),
    );
  });
}

router.get(
  "/payment-sessions/:paymentSessionId",
  asyncHandler(async (req, res) => {
    const data = await loadPaymentSessionData(
      String(req.params.paymentSessionId),
    );
    await requireAnyRole(uid(req), data.labOrganizationId, ADMIN_ROLES);
    // GET never creates a reversal. It may, however, reconcile an already
    // durable pending reservation so polling converges processor and local
    // accounting state after an ambiguous response or process interruption.
    if (data.reversal?.status === "pending") {
      return cancelPaymentSession(req, res);
    }
    return ok(res, data);
  }),
);

router.get(
  "/:labOrganizationId/accounts/:providerOrganizationId/balance",
  asyncHandler(async (req, res) => {
    const labOrganizationId = String(req.params.labOrganizationId);
    const providerOrganizationId = String(req.params.providerOrganizationId);
    await requireAnyRole(uid(req), labOrganizationId, ADMIN_ROLES);
    const provider = await db.query.organizations.findFirst({
      where: and(
        eq(organizations.id, providerOrganizationId),
        eq(organizations.parentLabOrganizationId, labOrganizationId),
        isNull(organizations.deletedAt),
      ),
    });
    if (!provider) throw new HttpError(404, "Customer account not found.");
    return ok(
      res,
      await calculateAccountBalance(
        db,
        labOrganizationId,
        providerOrganizationId,
      ),
    );
  }),
);

router.get(
  "/:labOrganizationId/accounts/:providerOrganizationId/customer-credits",
  asyncHandler(async (req, res) => {
    const labOrganizationId = String(req.params.labOrganizationId);
    const providerOrganizationId = String(req.params.providerOrganizationId);
    await requireAnyRole(uid(req), labOrganizationId, ADMIN_ROLES);
    // Keep reversal reservations out of the customer-facing balance even
    // while processor work is pending. This explicit reservation lookup also
    // covers generated credits whose source session has just entered the
    // reversal state and avoids exposing a stale available amount.
    const reservedReversals = await db
      .select({ paymentSessionId: statementPaymentReversals.paymentSessionId })
      .from(statementPaymentReversals)
      .where(ne(statementPaymentReversals.status, "failed"));
    const reservedSessionIds = new Set(
      reservedReversals.map((row) => row.paymentSessionId),
    );
    const rows = await db
      .select()
      .from(customerCredits)
      .where(
        and(
          eq(customerCredits.labOrganizationId, labOrganizationId),
          eq(customerCredits.providerOrganizationId, providerOrganizationId),
          isNull(customerCredits.reversedAt),
          gt(customerCredits.remainingAmount, "0"),
        ),
      )
      .orderBy(desc(customerCredits.createdAt), desc(customerCredits.id))
      .then((credits) =>
        credits.filter((credit) => !reservedSessionIds.has(credit.paymentSessionId)),
      );
    return ok(res, {
      totalAvailable: money(
        rows.reduce(
          (sum, credit) => sum + Number(credit.remainingAmount),
          0,
        ),
      ),
      credits: rows,
    });
  }),
);

// Reconciled, read-only customer statement ledger.  This intentionally derives
// monetary events from the immutable invoice/payment/credit ledgers rather than
// statement snapshots (snapshots overlap as the account rolls forward).
router.get(
  "/:labOrganizationId/accounts/:providerOrganizationId/statement-charges",
  asyncHandler(async (req, res) => {
    const pagination = parsePagination(req.query);
    const labOrganizationId = String(req.params.labOrganizationId);
    const providerOrganizationId = String(req.params.providerOrganizationId);
    await requireAnyRole(uid(req), labOrganizationId, ADMIN_ROLES);
    const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
      const parsed = new Date(`${value}T00:00:00.000Z`);
      return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
    });
    const dateRange = z.object({
      from: calendarDate.optional(),
      to: calendarDate.optional(),
      timeZone: z.string().min(1).max(100).optional(),
    }).safeParse(req.query);
    if (!dateRange.success || Boolean(dateRange.data.from) !== Boolean(dateRange.data.to)) {
      throw new HttpError(400, "Both from and to must be valid YYYY-MM-DD dates.");
    }
    const from = dateRange.data.from ?? null;
    const to = dateRange.data.to ?? null;
    const timeZone = dateRange.data.timeZone ?? "UTC";
    if (from && to && from > to) {
      throw new HttpError(400, "The from date must be on or before the to date.");
    }
    if (from) calendarDateInTimeZone(new Date(), timeZone);
    const provider = await db.query.organizations.findFirst({
      where: and(
        eq(organizations.id, providerOrganizationId),
        eq(organizations.parentLabOrganizationId, labOrganizationId),
        isNull(organizations.deletedAt),
      ),
    });
    if (!provider) throw new HttpError(404, "Customer account not found.");

    const [invoiceRows, paymentRows, statementRows, creditRows, activeCredits] = await Promise.all([
      db.select().from(invoices).where(and(
        eq(invoices.labOrganizationId, labOrganizationId),
        eq(invoices.providerOrganizationId, providerOrganizationId),
        isNull(invoices.deletedAt),
        ne(invoices.status, "void"),
        finalizedInvoiceSql(),
      )),
      db.select({ payment: payments, invoice: invoices })
        .from(payments)
        .innerJoin(invoices, eq(payments.invoiceId, invoices.id))
        .where(and(
          eq(invoices.labOrganizationId, labOrganizationId),
          eq(invoices.providerOrganizationId, providerOrganizationId),
          isNull(invoices.deletedAt),
          ne(invoices.status, "void"),
          finalizedInvoiceSql(),
        )),
      db.select({ statement: practiceStatements, sentAt: practiceStatementSends.sentAt })
        .from(practiceStatements)
        .innerJoin(practiceStatementSends,
          eq(practiceStatementSends.statementId, practiceStatements.id))
        .where(and(
          eq(practiceStatements.labOrganizationId, labOrganizationId),
          eq(practiceStatements.providerOrganizationId, providerOrganizationId),
          eq(practiceStatementSends.status, "sent"),
        )),
      // Deleted and voided invoices are loaded here on purpose. They are not
      // displayed, but the credit they consumed has to be discounted from the
      // credit's balance effect below.
      db.select({ application: workspaceDb.customerCreditApplications, invoice: invoices })
        .from(workspaceDb.customerCreditApplications)
        .innerJoin(invoices,
          eq(workspaceDb.customerCreditApplications.invoiceId, invoices.id))
        .where(and(
          eq(invoices.labOrganizationId, labOrganizationId),
          eq(invoices.providerOrganizationId, providerOrganizationId),
        )),
      db.select().from(customerCredits).where(and(
        eq(customerCredits.labOrganizationId, labOrganizationId),
        eq(customerCredits.providerOrganizationId, providerOrganizationId),
        isNull(customerCredits.reversedAt),
      )),
    ]);

    // One payment received from a practice settles many invoices, so `payments`
    // holds one row per invoice. An account ledger reports that as the single
    // event it was, so the rows are grouped back onto the payment session that
    // recorded them. A session owns its payment rows through one of three
    // links: the hosted statement payment stamps payment_session_id directly,
    // saved-card settlement writes the rows before the session exists and is
    // matched by its checkout, and the older Receive Payments batch is matched
    // by its deposit transaction.
    const referencedSessionIds = new Set<string>();
    const referencedCheckoutIds = new Set<string>();
    const referencedBankTransactionIds = new Set<string>();
    for (const row of paymentRows) {
      if (row.payment.paymentSessionId) {
        referencedSessionIds.add(row.payment.paymentSessionId);
      } else if (row.payment.providerPaymentCheckoutId) {
        referencedCheckoutIds.add(row.payment.providerPaymentCheckoutId);
      } else if (row.payment.bankTransactionId) {
        referencedBankTransactionIds.add(row.payment.bankTransactionId);
      }
    }
    for (const credit of activeCredits) {
      if (credit.paymentSessionId) referencedSessionIds.add(credit.paymentSessionId);
    }
    const sessionRows = referencedSessionIds.size || referencedCheckoutIds.size ||
      referencedBankTransactionIds.size
      ? await db.select().from(statementPaymentSessions).where(and(
        eq(statementPaymentSessions.labOrganizationId, labOrganizationId),
        eq(statementPaymentSessions.providerOrganizationId, providerOrganizationId),
        or(
          referencedSessionIds.size
            ? inArray(statementPaymentSessions.id, [...referencedSessionIds])
            : undefined,
          referencedCheckoutIds.size
            ? inArray(
              statementPaymentSessions.providerPaymentCheckoutId,
              [...referencedCheckoutIds],
            )
            : undefined,
          referencedBankTransactionIds.size
            ? inArray(
              statementPaymentSessions.bankTransactionId,
              [...referencedBankTransactionIds],
            )
            : undefined,
        ),
      ))
      : [];
    type SessionRow = (typeof sessionRows)[number];
    const sessionById = new Map(sessionRows.map((session) => [session.id, session]));
    const sessionByCheckoutId = new Map(sessionRows.flatMap((session) =>
      session.providerPaymentCheckoutId
        ? [[session.providerPaymentCheckoutId, session] as const]
        : []));
    const sessionByBankTransactionId = new Map(sessionRows.flatMap((session) =>
      session.bankTransactionId ? [[session.bankTransactionId, session] as const] : []));
    const sessionForPayment = (payment: {
      paymentSessionId: string | null;
      providerPaymentCheckoutId: string | null;
      bankTransactionId: string | null;
    }): SessionRow | null =>
      (payment.paymentSessionId ? sessionById.get(payment.paymentSessionId) : undefined)
      ?? (payment.providerPaymentCheckoutId
        ? sessionByCheckoutId.get(payment.providerPaymentCheckoutId)
        : undefined)
      ?? (payment.bankTransactionId
        ? sessionByBankTransactionId.get(payment.bankTransactionId)
        : undefined)
      ?? null;

    // A reader identifies the statement a payment was applied to by its period,
    // not its id. Sent statements are already loaded; a payment can also name a
    // statement that was generated but never sent.
    const statementLabelById = new Map<string, string>(
      statementRows.map((row) =>
        [row.statement.id, statementPeriodLabel(row.statement.periodStart)] as const),
    );
    const unlabelledStatementIds = Array.from(new Set(sessionRows.flatMap((session) =>
      session.statementId && !statementLabelById.has(session.statementId)
        ? [session.statementId]
        : [])));
    if (unlabelledStatementIds.length) {
      const extraStatements = await db
        .select({ id: practiceStatements.id, periodStart: practiceStatements.periodStart })
        .from(practiceStatements)
        .where(and(
          inArray(practiceStatements.id, unlabelledStatementIds),
          eq(practiceStatements.labOrganizationId, labOrganizationId),
          eq(practiceStatements.providerOrganizationId, providerOrganizationId),
        ));
      for (const statement of extraStatements) {
        statementLabelById.set(statement.id, statementPeriodLabel(statement.periodStart));
      }
    }

    type PaymentGroup = {
      session: SessionRow;
      payments: typeof paymentRows;
      creditTotal: number;
    };
    const paymentGroups = new Map<string, PaymentGroup>();
    const standalonePayments: typeof paymentRows = [];
    const groupFor = (session: SessionRow): PaymentGroup => {
      const existing = paymentGroups.get(session.id);
      if (existing) return existing;
      const group: PaymentGroup = { session, payments: [], creditTotal: 0 };
      paymentGroups.set(session.id, group);
      return group;
    };
    for (const row of paymentRows) {
      const session = sessionForPayment(row.payment);
      if (session) groupFor(session).payments.push(row);
      // A payment recorded directly against one invoice belongs to no session
      // and stays its own event, carrying that invoice's details.
      else standalonePayments.push(row);
    }
    // Applying a credit moves no money at the account level while the invoice
    // it settled is live: this ledger keeps that invoice's whole charge and
    // subtracts the credit once, at the event that created it. Deleting or
    // voiding the invoice drops its charge from the ledger and its balance
    // from the account, but the application row survives with the credit's
    // remaining amount already spent — so subtracting the credit's original
    // amount would report a balance lower than the customer's actual one, by
    // whatever the dead invoice consumed.
    //
    // A credit is therefore worth to this ledger only what it still backs: the
    // amount it has left, which is what the account balance counts and what
    // Receive Payments can still apply, plus what it settled on the invoices
    // this ledger carries. For a healthy credit those add back up to its
    // original amount, so nothing changes; a credit spent on an invoice that
    // is gone is worth that much less, exactly as the account reports it.
    //
    // The correction is made here rather than by restoring the credit's
    // remaining amount when its invoice goes away, because the account balance
    // is the operational figure and handing consumed credit back is a
    // deliberate accounting act (a reversal or a credit memo), not a silent
    // side effect of deleting an invoice. Reading it this way also covers
    // applications already lost with their invoice, which no write-path fix
    // could reach.
    const liveInvoiceIds = new Set(invoiceRows.map((invoice) => invoice.id));
    const liveCreditApplied = new Map<string, number>();
    for (const row of creditRows) {
      if (!liveInvoiceIds.has(row.invoice.id)) continue;
      liveCreditApplied.set(
        row.application.customerCreditId,
        (liveCreditApplied.get(row.application.customerCreditId) ?? 0) +
          Number(row.application.amount),
      );
    }
    const backedCreditAmount = (
      credit: { id: string; amount: string; remainingAmount: string },
    ) =>
      Math.min(
        Number(credit.amount),
        // Mirrors how the account balance counts available credit.
        Math.max(0, Number(credit.remainingAmount) || 0) +
          (liveCreditApplied.get(credit.id) ?? 0),
      );

    // An overpayment leaves the unapplied remainder as customer credit owned by
    // the same session. Folding it into that one payment event keeps the net
    // balance effect identical to listing the payments and the credit
    // separately, so the received amount is never counted twice. Credit from
    // any other source still accrues as its own event.
    const standaloneCredits: typeof activeCredits = [];
    for (const credit of activeCredits) {
      const session = credit.paymentSessionId
        ? sessionById.get(credit.paymentSessionId)
        : undefined;
      if (!session) standaloneCredits.push(credit);
      else groupFor(session).creditTotal += backedCreditAmount(credit);
    }

    type LedgerRow = {
      id: string;
      date: Date;
      kind: string;
      typeLabel: string;
      invoiceNumber: string | null;
      doctorIdentity: string | null;
      doctorName: string | null;
      patientName: string | null;
      invoiceAmount: string | null;
      paymentAmount: string | null;
      amount: number;
      statementId?: string;
      statementLabel?: string | null;
      paymentSessionId?: string | null;
      creditApplicationId?: string;
      paymentMethod?: string | null;
      referenceNumber?: string | null;
      invoiceCount?: number | null;
    };
    const events: LedgerRow[] = [];
    for (const invoice of invoiceRows) {
      events.push({
        id: `invoice:${invoice.id}`,
        date: invoice.issuedAt ?? invoice.createdAt,
        kind: "invoice",
        typeLabel: "Invoice",
        invoiceNumber: invoice.invoiceNumber,
        doctorIdentity: invoice.doctorIdentity,
        doctorName: doctorName(invoice),
        patientName: patientName(invoice),
        invoiceAmount: invoice.total,
        paymentAmount: null,
        amount: Number(invoice.total),
      });
    }
    for (const row of statementRows) {
      events.push({
        id: `statement:${row.statement.id}`,
        date: row.sentAt,
        kind: "statement",
        typeLabel: "Statement",
        invoiceNumber: null,
        doctorIdentity: null,
        doctorName: null,
        patientName: null,
        invoiceAmount: null,
        paymentAmount: null,
        amount: 0,
        statementId: row.statement.id,
        statementLabel: statementLabelById.get(row.statement.id) ?? null,
      });
    }
    for (const row of standalonePayments) {
      events.push({
        id: `payment:${row.payment.id}`,
        date: row.payment.paidAt,
        kind: "payment",
        typeLabel: "Payment",
        invoiceNumber: row.invoice.invoiceNumber,
        doctorIdentity: row.invoice.doctorIdentity,
        doctorName: doctorName(row.invoice),
        patientName: patientName(row.invoice),
        invoiceAmount: row.invoice.total,
        paymentAmount: row.payment.amount,
        amount: -Number(row.payment.amount),
        paymentSessionId: row.payment.paymentSessionId,
        paymentMethod: row.payment.paymentMethod,
        referenceNumber: row.payment.referenceNumber,
        invoiceCount: 1,
      });
    }
    for (const group of paymentGroups.values()) {
      const settledInvoices = [
        ...new Map(group.payments.map((row) => [row.invoice.id, row.invoice])).values(),
      ];
      // Computed from the rows this ledger actually counts rather than from the
      // session's recorded receivedAmount, so the event's balance effect stays
      // exactly what the individual rows contributed (a later voided invoice
      // drops its share from both).
      const receivedAmount = group.payments.reduce(
        (total, row) => total + Number(row.payment.amount),
        0,
      ) + group.creditTotal;
      const onlyInvoice = settledInvoices.length === 1 ? settledInvoices[0] : null;
      const invoiceCount = settledInvoices.length;
      events.push({
        id: `payment-session:${group.session.id}`,
        date: group.session.paymentDate
          ?? group.payments[0]?.payment.paidAt
          ?? group.session.createdAt,
        kind: "payment",
        typeLabel: invoiceCount > 1 ? `Payment (${invoiceCount} invoices)` : "Payment",
        // A payment spanning several invoices is its own account event, so it
        // carries the payment's identity instead of borrowing the number,
        // doctor, and patient of whichever invoice it happened to settle.
        invoiceNumber: onlyInvoice?.invoiceNumber ?? null,
        doctorIdentity: onlyInvoice?.doctorIdentity ?? null,
        doctorName: onlyInvoice ? doctorName(onlyInvoice) : group.session.doctorDisplayName,
        patientName: onlyInvoice ? patientName(onlyInvoice) : null,
        invoiceAmount: onlyInvoice?.total ?? null,
        paymentAmount: money(receivedAmount),
        amount: -receivedAmount,
        paymentSessionId: group.session.id,
        statementId: group.session.statementId ?? undefined,
        statementLabel: group.session.statementId
          ? statementLabelById.get(group.session.statementId) ?? null
          : null,
        paymentMethod: group.session.paymentMethod,
        referenceNumber: group.session.receiptNumber,
        invoiceCount,
      });
    }
    for (const row of creditRows) {
      // An application against an invoice this ledger no longer carries has
      // nothing to show against; its amount is already discounted from the
      // credit event above.
      if (!liveInvoiceIds.has(row.invoice.id)) continue;
      events.push({
        id: `credit-application:${row.application.id}`,
        date: row.application.createdAt,
        kind: "credit_application",
        typeLabel: "Credit applied",
        invoiceNumber: row.invoice.invoiceNumber,
        doctorIdentity: row.invoice.doctorIdentity,
        doctorName: doctorName(row.invoice),
        patientName: patientName(row.invoice),
        invoiceAmount: row.invoice.total,
        paymentAmount: row.application.amount,
        // Applying an existing credit reduces the invoice and the available
        // credit by the same amount, so it does not change the customer's net
        // account balance. The row is informational; the event that created
        // the credit carries the balance effect.
        amount: 0,
        paymentSessionId: row.application.paymentSessionId,
        creditApplicationId: row.application.id,
      });
    }
    for (const credit of standaloneCredits) {
      // Reported as what the credit is still worth to this account, matching
      // the event's balance effect.
      const backed = backedCreditAmount(credit);
      events.push({
        id: `customer-credit:${credit.id}`,
        date: credit.createdAt,
        kind: "customer_credit",
        typeLabel: "Customer credit",
        invoiceNumber: null,
        doctorIdentity: null,
        doctorName: null,
        patientName: null,
        invoiceAmount: null,
        paymentAmount: money(backed),
        amount: -backed,
      });
    }
    events.sort((a, b) => a.date.getTime() - b.date.getTime() ||
      a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
    let balance = 0;
    const allRows = events.map((event) => {
      balance += event.amount;
      return {
        id: event.id,
        date: event.date,
        type: event.kind,
        rowType: event.kind,
        typeLabel: event.typeLabel,
        statementId: event.statementId ?? null,
        statementLabel: event.statementLabel ?? null,
        paymentSessionId: event.paymentSessionId ?? null,
        creditApplicationId: event.creditApplicationId ?? null,
        invoiceNumber: event.invoiceNumber,
        invoiceCount: event.invoiceCount ?? null,
        doctorIdentity: event.doctorIdentity,
        doctorName: event.doctorName,
        patientName: event.patientName,
        invoiceAmount: event.invoiceAmount,
        paymentAmount: event.paymentAmount,
        paymentMethod: event.paymentMethod ?? null,
        referenceNumber: event.referenceNumber ?? null,
        openBalance: money(balance),
        // `balance` is the stable ledger column name used by Customer Center;
        // retain openBalance as an explicit alias for API consumers.
        balance: money(balance),
      };
    });
    const filteredRows = allRows.filter((row) =>
      !from || (
        calendarDateInTimeZone(row.date, timeZone) >= from &&
        calendarDateInTimeZone(row.date, timeZone) <= to!
      )
    );
    // The ledger is calculated in chronological order above. Responses are
    // newest-first, while the opening balance is the balance immediately
    // before the oldest row in the requested window.
    // Historical consumers rely on the unpaged chronological ledger. Paging
    // opts into the newer newest-first view without changing that contract.
    if (!pagination.active) {
      return ok(res, {
        providerOrganizationId,
        rows: filteredRows,
        endingBalance: money(balance),
      });
    }
    const newestRows = [...filteredRows].reverse();
    const page = pageRows(newestRows, pagination);
    const returnedRows = page.rows;
    const oldestReturned = returnedRows.at(-1);
    const oldestIndex = oldestReturned
      ? allRows.findIndex((row) => row === oldestReturned)
      : -1;
    const openingBalance = money(
      oldestIndex > 0 ? Number(allRows[oldestIndex - 1].balance) : 0,
    );
    // For a page, endingBalance brackets that page: it is the running balance
    // immediately after the newest returned event.
    const endingBalance = returnedRows.length
      ? returnedRows[0].balance
      : money(balance);
    return ok(
      res,
      {
        providerOrganizationId,
        ...page,
        openingBalance,
        endingBalance,
      },
    );
  }),
);

async function assertCardReversalEligible(
  tx: any,
  lockedSession: typeof statementPaymentSessions.$inferSelect,
  original: typeof statementPaymentSessions.$inferSelect,
  bankTransaction: typeof bankTransactions.$inferSelect | null,
  depositBatchProof = false,
) {
  if (lockedSession.labOrganizationId !== original.labOrganizationId ||
    lockedSession.providerOrganizationId !== original.providerOrganizationId ||
    lockedSession.paymentMethod !== "card" ||
    lockedSession.providerPaymentCheckoutId !== original.providerPaymentCheckoutId) {
    throw new HttpError(409, "Payment identity changed and requires review.");
  }
  const [ufAccount] = await tx.select().from(bankAccounts).where(and(
    eq(bankAccounts.labOrganizationId, lockedSession.labOrganizationId),
    eq(bankAccounts.accountType, "undeposited_funds"),
  ));
  const depositBatchPath = depositBatchProof &&
    bankTransaction?.status === "deposited_child" &&
    lockedSession.status === "deposited" &&
    !bankTransaction.reconciled;
  if (!bankTransaction || bankTransaction.deletedAt || bankTransaction.reconciled ||
    !ufAccount || bankTransaction.bankAccountId !== ufAccount.id ||
    (!depositBatchPath && lockedSession.status !== "undeposited")) {
    throw new HttpError(409, "A deposited or reconciled payment cannot be reversed.");
  }
  const applications = await tx.select().from(statementPaymentApplications)
    .where(eq(statementPaymentApplications.paymentSessionId, lockedSession.id)).for("update");
  for (const application of applications) {
    const [invoice] = await tx.select().from(invoices)
      .where(eq(invoices.id, application.invoiceId)).for("update");
    if (!invoice ||
      invoice.labOrganizationId !== lockedSession.labOrganizationId ||
      invoice.providerOrganizationId !== lockedSession.providerOrganizationId ||
      invoice.status === "void" ||
      Math.abs(Number(invoice.total) - Number(application.invoiceTotal)) > 0.005 ||
      Number(invoice.balanceDue) + Number(application.amount) > Number(invoice.total) + 0.005) {
      throw new HttpError(409, "Payment accounting changed and cannot be reversed automatically.");
    }
  }
}

async function prepareCardReversal(
  session: typeof statementPaymentSessions.$inferSelect,
  callerId: string,
  depositBatchProof = false,
) {
  const reversal = await db.transaction(async (tx) => {
    // Match Make Deposits' lock order: bank transaction first, then receipt.
    // Committing the reversal row while those locks are held is the durable
    // reservation that prevents a deposit from winning after processor work
    // begins.
    const [bankTransaction] = session.bankTransactionId
      ? await tx.select().from(bankTransactions)
          .where(eq(bankTransactions.id, session.bankTransactionId)).for("update")
      : [null];
    const [lockedSession] = await tx.select().from(statementPaymentSessions)
      .where(eq(statementPaymentSessions.id, session.id)).for("update");
    if (!lockedSession) throw new HttpError(404, "Payment session not found.");
    // Generated overpayment credits are part of this card receipt's
    // reversible accounting. Lock them before reserving processor work.
    const generatedCredits = await tx.select({ id: customerCredits.id })
      .from(customerCredits)
      .where(eq(customerCredits.paymentSessionId, session.id))
      .for("update");
    const [existing] = await tx
      .select()
      .from(statementPaymentReversals)
      .where(eq(statementPaymentReversals.paymentSessionId, session.id))
      .for("update");
    // Before a durable reservation exists, consumed generated credit makes
    // automatic reversal unsafe. Once reserved, all credit-selection queries
    // exclude this source, so processor_succeeded retries can finish locally.
    if (!existing && generatedCredits.length) {
      const consumed = await tx.select({ id: workspaceDb.customerCreditApplications.id })
        .from(workspaceDb.customerCreditApplications)
        .where(inArray(
          workspaceDb.customerCreditApplications.customerCreditId,
          generatedCredits.map((credit) => credit.id),
        ))
        .for("update");
      if (consumed.length) {
        throw new HttpError(409, "This payment's customer credit has already been consumed.");
      }
    }
    if (existing) return existing;
    await assertCardReversalEligible(tx, lockedSession, session, bankTransaction, depositBatchProof);
    const [created] = await tx
      .insert(statementPaymentReversals)
      .values({
        paymentSessionId: session.id,
        processorIdempotencyKey: `statement-card-reversal-${session.id}`,
        amount: money(Number(session.receivedAmount)),
        status: "pending_processor",
        initiatedByUserId: callerId,
      })
      .returning();
    return created;
  });
  if (reversal.status === "completed" || reversal.status === "processor_succeeded") {
    return reversal;
  }
  if (reversal.status === "failed") {
    throw new HttpError(409, "This card reversal failed and requires review.");
  }
  const leaseToken = randomUUID();
  const claimed = await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(statementPaymentReversals)
      .where(eq(statementPaymentReversals.id, reversal.id)).for("update");
    if (!locked || !["pending_processor", "processing"].includes(locked.status)) return false;
    const stale = !locked.processingStartedAt ||
      locked.processingStartedAt.getTime() < Date.now() - 5 * 60_000;
    if (locked.status === "processing" && !stale) return false;
    await tx.update(statementPaymentReversals).set({
      status: "processing", processorLeaseToken: leaseToken,
      processingStartedAt: new Date(), updatedAt: new Date(),
    }).where(eq(statementPaymentReversals.id, locked.id));
    return true;
  });
  if (!claimed) {
    throw new HttpError(409, "Card reversal is pending processor confirmation; retry safely.");
  }
  const leaseWhere = and(
    eq(statementPaymentReversals.id, reversal.id),
    eq(statementPaymentReversals.processorLeaseToken, leaseToken),
  );
  const [checkout] = session.providerPaymentCheckoutId
    ? await db
        .select()
        .from(providerPaymentCheckouts)
        .where(eq(providerPaymentCheckouts.id, session.providerPaymentCheckoutId))
    : [null];
  let chargeId = checkout?.stripeChargeId ?? null;
  const paymentIntentId = checkout?.stripePaymentIntentId ?? null;
  const stripe = await getUncachableStripeClient();
  if (!stripe || !paymentIntentId) {
    await db.update(statementPaymentReversals).set({
      status: "failed", failureReason: "processor_reference_unavailable", updatedAt: new Date(),
    }).where(leaseWhere);
    throw new HttpError(409, "The card processor reference is unavailable for reversal.");
  }
  try {
    if (!chargeId) {
      const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
      chargeId = typeof intent.latest_charge === "string"
        ? intent.latest_charge
        : intent.latest_charge?.id ?? null;
    }
    if (!chargeId) throw new Error("charge_unavailable");
    const charge = await stripe.charges.retrieve(chargeId);
    const amountCents = Math.round(Number(reversal.amount) * 100);
    const chargePaymentIntent = typeof charge.payment_intent === "string"
      ? charge.payment_intent
      : charge.payment_intent?.id;
    if (chargePaymentIntent !== paymentIntentId ||
      charge.currency !== reversal.currency || charge.amount !== amountCents) {
      await db.update(statementPaymentReversals).set({
        status: "failed", failureReason: "processor_amount_mismatch", updatedAt: new Date(),
      }).where(leaseWhere);
      throw new HttpError(409, "The processor charge cannot be safely reversed.");
    }
    // A persisted refund id is authoritative on retries. It can be written
    // before the response is lost, so retrieve it before another API call.
    if (reversal.stripeRefundId) {
      const known = await stripe.refunds.retrieve(reversal.stripeRefundId);
      const knownCharge = typeof known.charge === "string" ? known.charge : known.charge?.id;
      if (knownCharge !== chargeId || known.amount !== amountCents || known.currency !== reversal.currency) {
        await db.update(statementPaymentReversals).set({
          status: "failed", failureReason: "processor_refund_mismatch", updatedAt: new Date(),
        }).where(leaseWhere);
        throw new HttpError(409, "The processor refund did not match this payment.");
      }
      if (known.status === "succeeded") {
        const [confirmed] = await db.update(statementPaymentReversals).set({
          status: "processor_succeeded", failureReason: null, processorLeaseToken: null, processingStartedAt: null, updatedAt: new Date(),
        }).where(leaseWhere).returning();
        return confirmed;
      }
      if (known.status === "failed" || known.status === "canceled") {
        await db.update(statementPaymentReversals).set({
          status: "failed", failureReason: "processor_reversal_failed",
          processorLeaseToken: null, processingStartedAt: null, updatedAt: new Date(),
        }).where(leaseWhere);
        throw new HttpError(409, "The card processor declined the reversal.");
      }
    }
    // Idempotency keys eventually expire at the processor. Metadata provides a
    // durable second lookup boundary before a create can be attempted again.
    const priorRefunds = await stripe.refunds.list({ charge: chargeId, limit: 100 });
    const taggedRefund = priorRefunds.data.find(
      (item) => item.metadata?.statementPaymentReversalId === reversal.id,
    );
    if (taggedRefund) {
      const taggedCharge = typeof taggedRefund.charge === "string"
        ? taggedRefund.charge : taggedRefund.charge?.id;
      if (taggedCharge !== chargeId || taggedRefund.amount !== amountCents ||
        taggedRefund.currency !== reversal.currency) {
        await db.update(statementPaymentReversals).set({
          status: "failed", failureReason: "processor_refund_mismatch", updatedAt: new Date(),
        }).where(leaseWhere);
        throw new HttpError(409, "The processor refund did not match this payment.");
      }
      const [taggedSaved] = await db.update(statementPaymentReversals).set({
        stripeRefundId: taggedRefund.id,
        status: taggedRefund.status === "succeeded" ? "processor_succeeded" :
          (taggedRefund.status === "failed" || taggedRefund.status === "canceled") ? "failed" : "pending_processor",
        failureReason: taggedRefund.status === "succeeded" ? null :
          (taggedRefund.status === "failed" || taggedRefund.status === "canceled") ? "processor_reversal_failed" : "processor_reversal_pending",
        processorLeaseToken: null, processingStartedAt: null,
        updatedAt: new Date(),
      }).where(leaseWhere).returning();
      if (!taggedSaved) {
        throw new HttpError(409, "Card reversal is being reconciled by another request.");
      }
      if (taggedRefund.status === "succeeded") {
        return taggedSaved;
      }
      if (taggedRefund.status === "failed" || taggedRefund.status === "canceled") {
        throw new HttpError(409, "The card processor declined the reversal.");
      }
      throw new HttpError(409, "Card reversal is pending processor confirmation; retry safely.");
    }
    try {
      await db.transaction(async (tx) => {
        const [lockedBank] = session.bankTransactionId
          ? await tx.select().from(bankTransactions)
              .where(eq(bankTransactions.id, session.bankTransactionId)).for("update")
          : [null];
        const [lockedSession] = await tx.select().from(statementPaymentSessions)
          .where(eq(statementPaymentSessions.id, session.id)).for("update");
        if (!lockedSession) throw new HttpError(404, "Payment session not found.");
        // cancelPaymentSession already holds the matching session-level
        // provider-account lock through refund and local finalization.
        await assertCardReversalEligible(tx, lockedSession, session, lockedBank, depositBatchProof);
      });
    } catch (error) {
      await db.update(statementPaymentReversals).set({
        status: "failed", failureReason: "accounting_review_required",
        processorLeaseToken: null, processingStartedAt: null, updatedAt: new Date(),
      }).where(leaseWhere);
      throw error;
    }
    const refund = await stripe.refunds.create(
      { charge: chargeId, amount: amountCents, metadata: { statementPaymentReversalId: reversal.id } },
      { idempotencyKey: reversal.processorIdempotencyKey },
    );
    const createdRefundCharge = typeof refund.charge === "string"
      ? refund.charge
      : refund.charge?.id;
    if (createdRefundCharge !== chargeId || refund.amount !== amountCents ||
      refund.currency !== reversal.currency) {
      await db.update(statementPaymentReversals).set({
        status: "failed", failureReason: "processor_refund_mismatch", updatedAt: new Date(),
      }).where(leaseWhere);
      throw new HttpError(409, "The processor refund did not match this payment.");
    }
    if (refund.status === "failed" || refund.status === "canceled") {
      await db.update(statementPaymentReversals).set({
        stripePaymentIntentId: paymentIntentId, stripeChargeId: chargeId,
        stripeRefundId: refund.id, status: "failed",
        failureReason: "processor_reversal_failed", updatedAt: new Date(),
      }).where(leaseWhere);
      throw new HttpError(409, "The card processor declined the reversal.");
    }
    if (refund.status !== "succeeded") {
      await db.update(statementPaymentReversals).set({
        stripePaymentIntentId: paymentIntentId, stripeChargeId: chargeId,
        stripeRefundId: refund.id, status: "pending_processor",
        failureReason: "processor_reversal_pending", processorLeaseToken: null,
        processingStartedAt: null, updatedAt: new Date(),
      }).where(leaseWhere);
      throw new HttpError(409, "Card reversal is pending processor confirmation; retry safely.");
    }
    const [confirmed] = await db.update(statementPaymentReversals).set({
      stripePaymentIntentId: paymentIntentId, stripeChargeId: chargeId,
      stripeRefundId: refund.id, status: "processor_succeeded",
      failureReason: null, processorLeaseToken: null, processingStartedAt: null, updatedAt: new Date(),
    }).where(leaseWhere).returning();
    if (!confirmed) {
      throw new HttpError(409, "Card reversal is being reconciled by another request.");
    }
    return confirmed;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const stripeError = error as { type?: string };
    if (stripeError.type === "StripeInvalidRequestError") {
      await db.update(statementPaymentReversals).set({
        status: "failed", failureReason: "processor_invalid_request", updatedAt: new Date(),
      }).where(leaseWhere);
      throw new HttpError(409, "The card processor rejected the reversal.");
    }
    // Network/API errors are deliberately not interpreted as a failed refund:
    // Stripe may have accepted it. Replaying this durable idempotency key
    // obtains the authoritative outcome without refunding twice.
    await db.update(statementPaymentReversals).set({
      status: "pending_processor", failureReason: "processor_confirmation_pending",
      processorLeaseToken: null, processingStartedAt: null, updatedAt: new Date(),
    }).where(leaseWhere);
    throw new HttpError(409, "Card reversal outcome is pending processor confirmation; retry safely.");
  }
}

async function cancelPaymentSession(req: any, res: any) {
    const callerId = uid(req);
    const id = String(req.params.paymentSessionId);
    const existing = await db.query.statementPaymentSessions.findFirst({
      where: eq(statementPaymentSessions.id, id),
    });
    if (!existing) throw new HttpError(404, "Payment session not found.");
    await requireAnyRole(callerId, existing.labOrganizationId, ADMIN_ROLES);
    const providerLock = await acquireProviderAccountLock(
      existing.labOrganizationId,
      existing.providerOrganizationId,
    );
    let depositBatchLockHeld = false;
    try {
    let cardReversal: typeof statementPaymentReversals.$inferSelect | null = null;
    let depositBatchReversalProof = false;
    if (existing.paymentMethod === "card") {
      if (existing.bankTransactionId) {
        await acquireDepositBatchMutationLock(
          existing.labOrganizationId,
          providerLock.bundle,
        );
        depositBatchLockHeld = true;
        const reversibleMember = await db.transaction((tx) =>
          assertDepositBatchChildReversible(
            tx,
            existing.labOrganizationId,
            existing.bankTransactionId!,
            { fenceHeld: true },
          ),
        );
        depositBatchReversalProof = Boolean(reversibleMember);
      }
      try {
        cardReversal = await prepareCardReversal(existing, callerId, depositBatchReversalProof);
      } catch (error) {
        if (error instanceof HttpError && error.statusCode === 409) {
          const [reserved] = await db.select({
            id: statementPaymentReversals.id,
            status: statementPaymentReversals.status,
          })
            .from(statementPaymentReversals)
            .where(eq(statementPaymentReversals.paymentSessionId, id));
          if (reserved && ["pending_processor", "processing"].includes(reserved.status)) {
            const responseData = await loadPaymentSessionData(id);
            return ok(res, responseData);
          }
        }
        throw error;
      }
    }

    const result = await db.transaction(async (tx) => {
      if (existing.bankTransactionId) {
        await releaseBatchForChild(
          tx,
          existing.labOrganizationId,
          existing.bankTransactionId,
          { fenceHeld: depositBatchLockHeld },
        );
      }
      // Make Deposits also locks the bank transaction first. Keeping the same
      // order prevents a deposit/cancellation deadlock.
      const [transaction] = existing.bankTransactionId
        ? await tx
            .select()
            .from(bankTransactions)
            .where(eq(bankTransactions.id, existing.bankTransactionId))
            .for("update")
        : [null];
      const [session] = await tx
        .select()
        .from(statementPaymentSessions)
        .where(eq(statementPaymentSessions.id, id))
        .for("update");
      if (!session) throw new HttpError(404, "Payment session not found.");
      if (session.status === "cancelled") {
        return { session, duplicate: true };
      }
      if (session.paymentMethod === "card" && cardReversal?.status !== "processor_succeeded") {
        throw new HttpError(409, "Card reversal is pending processor confirmation.");
      }
      if (session.bankTransactionId && (!transaction || transaction.deletedAt)) {
        throw new HttpError(409, "Payment transaction is unavailable.");
      }
      if (transaction?.reconciled) {
        throw new HttpError(409, "A reconciled payment cannot be cancelled.");
      }
      const [ufAccount] = await tx
        .select()
        .from(bankAccounts)
        .where(
          and(
            eq(bankAccounts.labOrganizationId, session.labOrganizationId),
            eq(bankAccounts.accountType, "undeposited_funds"),
          ),
        );
      if (
        session.bankTransactionId &&
        (!ufAccount || transaction?.bankAccountId !== ufAccount.id)
      ) {
        throw new HttpError(
          409,
          "A deposited payment cannot be cancelled. Record a reversal instead.",
        );
      }
      const applications = await tx
        .select()
        .from(statementPaymentApplications)
        .where(eq(statementPaymentApplications.paymentSessionId, id))
        .for("update");
      const creditApplications = await tx
        .select()
        .from(workspaceDb.customerCreditApplications)
        .where(eq(workspaceDb.customerCreditApplications.paymentSessionId, id))
        .for("update");
      for (const application of applications) {
        const [invoice] = await tx
          .select()
          .from(invoices)
          .where(eq(invoices.id, application.invoiceId))
          .for("update");
        if (!invoice) continue;
        if (
          invoice.labOrganizationId !== session.labOrganizationId ||
          invoice.providerOrganizationId !== session.providerOrganizationId ||
          invoice.status === "void" ||
          Math.abs(Number(invoice.total) - Number(application.invoiceTotal)) >
            0.005
        ) {
          throw new HttpError(
            409,
            `Invoice ${application.invoiceNumber} changed after payment and cannot be restored automatically.`,
          );
        }
        const restored = Number(invoice.balanceDue) + Number(application.amount);
        const total = Number(invoice.total);
        if (restored > total + 0.005) {
          throw new HttpError(
            409,
            `Invoice ${application.invoiceNumber} has an incompatible balance and cannot be restored automatically.`,
          );
        }
        await tx
          .update(invoices)
          .set({
            balanceDue: money(restored),
            status:
              restored >= total - 0.005
                ? "open"
                : restored <= 0.005
                  ? "paid"
                  : "partially_paid",
            updatedByUserId: callerId,
            updatedAt: new Date(),
          })
          .where(eq(invoices.id, invoice.id));
      }
      if (applications.length > 0) {
        const sessionPaymentLink = session.providerPaymentCheckoutId
          ? or(
              eq(payments.paymentSessionId, session.id),
              eq(payments.providerPaymentCheckoutId, session.providerPaymentCheckoutId),
            )
          : eq(payments.paymentSessionId, session.id);
        // Scope both receipt-created rows and the original saved-card checkout
        // settlement rows to this tenant's locked application invoices.
        const removedPayments = await tx
          .delete(payments)
          .where(
            and(
              inArray(
                payments.invoiceId,
                applications.map((item) => item.invoiceId),
              ),
              sessionPaymentLink,
            ),
          )
          .returning();
        // These rows are gone from the live books, but they were in force
        // between their payment date and now, and a dated report has to be
        // able to say so.
        await archiveReversedSettlements(
          tx,
          removedPayments.map((payment) => ({
            labOrganizationId: session.labOrganizationId,
            invoiceId: payment.invoiceId,
            sourceType: "payment" as const,
            sourceId: payment.id,
            paymentSessionId: session.id,
            amount: payment.amount,
            settledAt: payment.paidAt ?? session.paymentDate ?? new Date(),
            reversedByUserId: callerId,
          })),
        );
      }
      // Return consumed credit before removing its immutable allocation
      // ledger. A cancelled credit-only payment therefore has no cash entry
      // and exactly restores the credit available for a later attempt.
      const restoredCreditById = new Map<string, number>();
      for (const application of creditApplications) {
        restoredCreditById.set(
          application.customerCreditId,
          (restoredCreditById.get(application.customerCreditId) ?? 0) +
            Number(application.amount),
        );
      }
      for (const [creditId, amount] of restoredCreditById) {
        const [credit] = await tx
          .select()
          .from(customerCredits)
          .where(eq(customerCredits.id, creditId))
          .for("update");
        if (!credit || credit.reversedAt) {
          throw new HttpError(409, "Customer credit changed and cannot be restored automatically.");
        }
        await tx.update(customerCredits).set({
          remainingAmount: money(Number(credit.remainingAmount) + amount),
          updatedAt: new Date(),
        }).where(eq(customerCredits.id, credit.id));
      }
      const removedCreditApplications = await tx
        .delete(workspaceDb.customerCreditApplications)
        .where(eq(workspaceDb.customerCreditApplications.paymentSessionId, session.id))
        .returning();
      // Applied credit settles an invoice the same way cash does, and on the
      // session's payment date, so its removal is archived the same way.
      await archiveReversedSettlements(
        tx,
        removedCreditApplications.map((application) => ({
          labOrganizationId: session.labOrganizationId,
          invoiceId: application.invoiceId,
          sourceType: "customer_credit_application" as const,
          sourceId: application.id,
          paymentSessionId: session.id,
          amount: application.amount,
          settledAt: session.paymentDate ?? application.createdAt ?? new Date(),
          reversedByUserId: callerId,
        })),
      );
      await tx
        .delete(customerCredits)
        .where(eq(customerCredits.paymentSessionId, session.id));
      if (session.bankTransactionId) {
        await tx
          .delete(bankTransactionInvoices)
          .where(eq(bankTransactionInvoices.bankTransactionId, session.bankTransactionId));
        await tx
          .update(bankTransactions)
          .set({
            status: "void",
            deletedAt: new Date(),
            deletedByUserId: callerId,
            updatedAt: new Date(),
          })
          .where(eq(bankTransactions.id, session.bankTransactionId));
      }
      const [cancelled] = await tx
        .update(statementPaymentSessions)
        .set({
          status: "cancelled",
          cancelledAt: new Date(),
          cancelledByUserId: callerId,
          updatedAt: new Date(),
        })
        .where(eq(statementPaymentSessions.id, session.id))
        .returning();
      return { session: cancelled, duplicate: false };
    });
    if (cardReversal && result.session.status === "cancelled") {
      await db.update(statementPaymentReversals).set({
        status: "completed", completedAt: new Date(), failureReason: null, updatedAt: new Date(),
      }).where(eq(statementPaymentReversals.id, cardReversal.id));
    }
    if (!result.duplicate) {
      await deliverPaymentNotifications({
        origin: "lab",
        event: "reversal",
        sourceType: "statement_payment_session",
        sourceId: `${id}:reversal`,
        labOrganizationId: existing.labOrganizationId,
        providerOrganizationId: existing.providerOrganizationId,
        amount: existing.receivedAmount,
        paymentMethod: existing.paymentMethod,
      });
      await writeAuditLog({
        req,
        organizationId: existing.labOrganizationId,
        action: "statement_payment_cancelled",
        entityType: "statement_payment_session",
        entityId: id,
        metadataJson: { bankTransactionId: existing.bankTransactionId },
      });
    }
    const responseData = await loadPaymentSessionData(id);
    return ok(res, responseData);
    } finally {
      await providerLock.release();
    }
}

router.delete(
  "/payment-sessions/:paymentSessionId",
  asyncHandler(cancelPaymentSession),
);

router.post(
  "/payment-sessions/:paymentSessionId/reversal",
  asyncHandler(cancelPaymentSession),
);

function receiptLogo(data: {
  receiptLogoBase64: string | null;
  receiptLogoContentType: string | null;
}) {
  if (!data.receiptLogoBase64 || !data.receiptLogoContentType) return null;
  return {
    content: Buffer.from(data.receiptLogoBase64, "base64"),
    contentType: data.receiptLogoContentType,
  };
}

router.get(
  "/payment-sessions/:paymentSessionId/receipt.pdf",
  asyncHandler(async (req, res) => {
    const data = await loadPaymentSessionData(
      String(req.params.paymentSessionId),
    );
    await requireAnyRole(uid(req), data.labOrganizationId, ADMIN_ROLES);
    const logo = receiptLogo(data);
    const pdf = await generatePaymentReceiptPdf(data, logo?.content ?? null);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${data.receiptNumber}.pdf"`,
    );
    res.setHeader("Content-Length", String(pdf.length));
    return res.end(pdf);
  }),
);

const sendReceiptSchema = z.object({
  to: z.string().email().max(320),
  subject: z.string().trim().min(1).max(998).optional(),
  body: z.string().min(1).max(20000).optional(),
});

router.post(
  "/payment-sessions/:paymentSessionId/send-receipt",
  asyncHandler(async (req, res) => {
    const input = sendReceiptSchema.parse(req.body);
    const data = await loadPaymentSessionData(
      String(req.params.paymentSessionId),
    );
    await requireAnyRole(uid(req), data.labOrganizationId, ADMIN_ROLES);
    const template = await loadReceiptTemplate(data.labOrganizationId);
    const logo = receiptLogo(data);
    const subject = renderPaymentReceiptTemplate(
      input.subject || template.emailSubject,
      data,
    );
    const text = renderPaymentReceiptTemplate(
      input.body || template.emailBody,
      data,
    );
    const pdf = await generatePaymentReceiptPdf(data, logo?.content ?? null);
    const htmlBody = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\n/g, "<br />");
    const result = await sendMail({
      to: input.to,
      fromName: data.labName,
      subject,
      text,
      html: `<div style="font-family:Arial,sans-serif;max-width:640px;">${
        logo
          ? `<img src="cid:${LAB_LOGO_CID}" alt="Lab logo" style="max-width:150px;max-height:60px;margin-bottom:16px;" />`
          : ""
      }${htmlBody}</div>`,
      attachments: [
        {
          filename: `${data.receiptNumber}.pdf`,
          content: pdf,
          contentType: "application/pdf",
        },
        ...(logo
          ? [
              {
                filename: "lab-logo",
                content: logo.content,
                contentType: logo.contentType,
                cid: LAB_LOGO_CID,
                contentDisposition: "inline" as const,
              },
            ]
          : []),
      ],
    });
    await db
      .update(statementPaymentSessions)
      .set({
        receiptEmailStatus: result.sent ? "sent" : "failed",
        receiptEmailReason: result.reason ?? null,
        receiptEmailSentAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(statementPaymentSessions.id, data.id));
    await writeAuditLog({
      req,
      organizationId: data.labOrganizationId,
      action: "payment_receipt_email_attempted",
      entityType: "statement_payment_session",
      entityId: data.id,
      metadataJson: {
        delivered: result.sent,
        reason: result.reason ?? null,
        recipient: input.to,
      },
    });
    return ok(res, {
      delivered: result.sent,
      reason: result.reason ?? null,
      recipient: input.to,
      subject,
      body: text,
    });
  }),
);

router.get(
  "/:labOrganizationId/payment-receipt-template",
  asyncHandler(async (req, res) => {
    const labOrganizationId = String(req.params.labOrganizationId);
    await requireAnyRole(uid(req), labOrganizationId, ADMIN_ROLES);
    return ok(res, {
      ...(await loadReceiptTemplate(labOrganizationId)),
      placeholders: PAYMENT_RECEIPT_PLACEHOLDERS.map(
        (name) => `{{${name}}}`,
      ),
    });
  }),
);

const receiptTemplateSchema = z.object({
  emailSubject: z.string().max(998).nullish(),
  emailBody: z.string().max(20000).nullish(),
});

const updateReceiptTemplate = asyncHandler(async (req, res) => {
    const labOrganizationId = String(req.params.labOrganizationId);
    await requireAnyRole(uid(req), labOrganizationId, ADMIN_ROLES);
    const input = receiptTemplateSchema.parse(req.body);
    const stored = {
      emailSubject: input.emailSubject?.trim() || null,
      emailBody: input.emailBody?.trim() ? input.emailBody : null,
    };
    const key = `${RECEIPT_TEMPLATE_PREFIX}${labOrganizationId}`;
    await db
      .insert(systemSettings)
      .values({
        key,
        value: JSON.stringify(stored),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: { value: JSON.stringify(stored), updatedAt: new Date() },
      });
    await writeAuditLog({
      req,
      organizationId: labOrganizationId,
      action: "payment_receipt_template_updated",
      entityType: "organization",
      entityId: labOrganizationId,
      metadataJson: {
        customizedSubject: !!stored.emailSubject,
        customizedBody: !!stored.emailBody,
      },
    });
    return ok(res, {
      ...normalizePaymentReceiptTemplate(stored),
      placeholders: PAYMENT_RECEIPT_PLACEHOLDERS.map(
        (name) => `{{${name}}}`,
      ),
    });
  });

router.put(
  "/:labOrganizationId/payment-receipt-template",
  updateReceiptTemplate,
);
router.patch(
  "/:labOrganizationId/payment-receipt-template",
  updateReceiptTemplate,
);

export default router;
