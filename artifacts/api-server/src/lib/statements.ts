import { finalizedInvoiceSql } from "./recovery-billing-hold";
import PDFDocument from "pdfkit";
import fs from "node:fs";
import path from "node:path";
import { normalizePhoneE164 } from "./account-link-sms";
import archiver from "archiver";
import { and, asc, desc, eq, gte, inArray, lt, or, isNull, ne, lte, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { db } from "@workspace/db";
import * as dbSchema from "@workspace/db";
import {
  cases,
  invoiceLineItems,
  invoices,
  organizationAdditionalEmails,
  organizations,
  payments,
  practiceStatements,
  practiceStatementSends,
  statementLinkTokens,
  statementSchedules,
  statementSendRuns,
  doctorProfiles,
  doctorPhoneEntries,
  doctorEmailEntries,
} from "@workspace/db";
import { logger } from "./logger";
import {
  openInvoiceTemplateImageStream,
  openLabLogoStream,
} from "./lab-logo-storage";
import { LAB_LOGO_CID, getAppBaseUrl, sendMail } from "./mail";
import { checkEmailPref } from "./email-prefs";
import { formatNumericDate, formatNumericDateTime, formatNumericMonthYear } from "./date-format";
import { invoiceDueDate } from "./invoice-due-date";
import {
  coerceStatementTemplate,
  StatementDefaultTextBlock,
  type StatementTemplateSection,
} from "./statement-template";

// ─────────────────────────────────────────────────────────────────────────────
// Shared PDF-persist helper used by the batch-send, monthly scheduler, and
// the manual generate route. Writes the PDF buffer to the local
// uploads/practice-statements directory and returns addressing metadata.
// ─────────────────────────────────────────────────────────────────────────────
const PRACTICE_STATEMENTS_DIR = path.resolve(
  process.cwd(),
  "uploads",
  "practice-statements",
);

export async function persistStatementPdf(opts: {
  buffer: Buffer;
  providerOrganizationId: string;
  periodMonth: string;
}): Promise<{ storageKey: string; fileName: string; size: number }> {
  const practice = await db.query.organizations.findFirst({
    where: eq(organizations.id, opts.providerOrganizationId),
  });
  const safeName = (practice?.displayName || practice?.name || "practice")
    .replace(/[^a-z0-9-_]+/gi, "_")
    .slice(0, 60);
  const key = randomBytes(8).toString("hex");
  const fileName = `statement-${safeName}-${opts.periodMonth}-${key}.pdf`;
  fs.mkdirSync(PRACTICE_STATEMENTS_DIR, { recursive: true });
  const filePath = path.resolve(PRACTICE_STATEMENTS_DIR, fileName);
  if (!filePath.startsWith(PRACTICE_STATEMENTS_DIR + path.sep)) {
    throw new Error("Invalid statement file path.");
  }
  fs.writeFileSync(filePath, opts.buffer);
  return { storageKey: fileName, fileName, size: opts.buffer.length };
}

// Automatic retry configuration for failed statement sends.
// MAX_ATTEMPTS includes the initial attempt, so a value of 3 means
// up to two automatic retries after the first failure.
export const STATEMENT_MAX_ATTEMPTS = 3;
// Backoff schedule (ms) per attempt number that just completed:
// after attempt 1 → wait 30 min before attempt 2
// after attempt 2 → wait 2 hours before attempt 3
const STATEMENT_RETRY_BACKOFF_MS: number[] = [
  30 * 60 * 1000,
  2 * 60 * 60 * 1000,
];

function nextAttemptDelayMs(justCompletedAttempt: number): number | null {
  const idx = justCompletedAttempt - 1;
  if (idx < 0 || idx >= STATEMENT_RETRY_BACKOFF_MS.length) return null;
  return STATEMENT_RETRY_BACKOFF_MS[idx]!;
}

function defaultStatementPeriodLabel(date = new Date()): string {
  const period = new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
  }).format(date);
  return `Statement for ${period}`;
}

export type SendTrigger = "schedule" | "manual";

export interface LineItemEntry {
  id: string;
  description: string;
  quantity: number;
  unitPrice: string;
  lineTotal: string;
  isDiscount: boolean;
  parentLineItemId: string | null;
  toothLabel: string | null;
  toothNumber: number | null;
  sortOrder: number;
}

export interface StatementContactBlock {
  displayName: string | null;
  legalName: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  phone: string | null;
  billingEmail: string | null;
  additionalEmails: string[];
  accountNumber: string | null;
  licenseNumber: string | null;
  phones: string[];
  emails: string[];
}
export interface StatementPayment {
  id: string;
  invoiceId: string;
  amount: string;
  paidAt: Date;
  paymentMethod: string;
  referenceNumber: string | null;
}
export interface PracticeStatementData {
  /**
   * Group key. In practice mode this is the provider organization id; in
   * doctor mode it is the doctor name (or the sentinel no-doctor key). It is
   * NOT necessarily a valid organization id — use providerOrganizationId for
   * any foreign-key or contact lookup.
   */
  practiceId: string;
  practiceName: string;
  practiceEmail: string | null;
  /** True when the practice has opted out of receiving statement emails. */
  statementEmailOptOut: boolean;
  /**
   * The resolved provider organization id backing this group's contact info,
   * or null when a doctor group could not be tied to a provider org. Safe to
   * use for statement_send_runs.practiceOrganizationId and phone lookups.
   */
  providerOrganizationId?: string | null;
  /** Practice phone (for SMS), resolved from the provider org. */
  phone?: string | null;
  /** Contact data used by the server-authoritative statement renderer. */
  labContact?: StatementContactBlock | null;
  practiceContact?: StatementContactBlock | null;
  doctorContact?: StatementContactBlock | null;
  /** How this group was formed. */
  recipientType?: "practice" | "doctor";
  invoiceCount: number;
  totalBilled: number;
  totalPaid: number;
  openBalance: number;
  /**
   * Most recent payment recorded across this group's invoices, used to show
   * a "Paid On: MM/DD/YYYY (Method)" line on the generated PDF. Null/absent
   * when no payment has been recorded.
   */
  paidAt?: Date | null;
  paymentMethod?: string | null;
  payments?: StatementPayment[];
  invoices: Array<{
    /** Database id of the invoice row — used when persisting practiceStatements records. */
    id: string;
    invoiceNumber: string;
    issuedAt: Date | null;
    dueAt: Date | null;
    status: string;
    total: string;
    balanceDue: string;
    patientName: string | null;
    billTo: string | null;
    /**
     * Doctor resolved from the invoice's linked case, or null when the case
     * carries no doctor (or the invoice has no case). Drives the per-doctor
     * partitioning of a practice bundle; never inferred from billTo text.
     */
    doctorName?: string | null;
    /** Line items for this invoice, used to render group subtotals in the PDF. */
    lineItems?: LineItemEntry[];
  }>;
  /**
   * Unique doctors associated with this practice's invoices (practice mode
   * only). Populated by buildPracticeStatementsForScope; empty in doctor mode.
   * Includes a trailing NO_DOCTOR_KEY entry when the practice has in-scope
   * invoices with no resolvable doctor, so those invoices can be selected
   * (and attached) explicitly instead of silently disappearing.
   */
  doctors?: Array<{
    key: string;
    name: string;
    email: string | null;
    phone: string | null;
    /** In-scope invoice count attributable to this doctor at this practice. */
    invoiceCount?: number;
    totalBilled?: number;
    openBalance?: number;
  }>;
}

function statementInvoiceDetails(
  invoices: PracticeStatementData["invoices"],
): Record<string, {
  invoiceNumber: string;
  patientName: string | null;
  billTo: string | null;
  issuedAt: string | null;
  dueAt: string | null;
  status: string;
}> {
  return Object.fromEntries(
    invoices.map((invoice) => [
      invoice.id,
      {
        invoiceNumber: invoice.invoiceNumber,
        patientName: invoice.patientName,
        billTo: invoice.billTo,
        issuedAt: invoice.issuedAt?.toISOString() ?? null,
        dueAt: invoice.dueAt?.toISOString() ?? null,
        status: invoice.status,
      },
    ]),
  );
}

export interface PracticeAccountSummary {
  practiceId: string;
  practiceName: string;
  billingEmail: string | null;
  phone: string | null;
  openInvoiceCount: number;
  openInvoiceTotal: number;
  unpaidStatements: Array<{
    id: string;
    date: Date;
    periodStart: Date;
    periodEnd: Date;
    remainingBalance: number;
    overdue: boolean;
    detailProvenance: "snapshot" | "live" | "mixed";
  }>;
  hasLegacyStatements: boolean;
  totalOpenBalance: number;
  overdueBalance: number;
  invoiceCount: number;
  totalBilled: number;
  totalPaid: number;
}

type AccountSummaryInvoice = {
  id: string;
  providerOrganizationId: string | null;
  status: string;
  total?: string | number | null;
  balanceDue: string | number | null;
  deletedAt?: Date | null;
};

type AccountSummaryStatement = {
  id: string;
  providerOrganizationId: string;
  periodStart: Date;
  periodEnd: Date;
  invoiceIdsJson: unknown;
  createdAt: Date;
  invoiceDetailsJson?: unknown;
};

type AccountSummaryPractice = {
  id: string;
  name: string;
  displayName: string | null;
  billingEmail: string | null;
  phone: string | null;
};

/** Classify snapshot coverage using only expected invoice ids and valid details. */
export function statementDetailProvenance(
  invoiceIds: string[],
  rawDetails: unknown,
): "snapshot" | "live" | "mixed" {
  const expected = new Set(invoiceIds);
  const entries =
    rawDetails && typeof rawDetails === "object" && !Array.isArray(rawDetails)
      ? Object.entries(rawDetails as Record<string, unknown>)
      : [];
  const valid = entries.filter(
    ([id, value]) =>
      expected.has(id) &&
      !!value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof (value as Record<string, unknown>).invoiceNumber === "string",
  ).length;
  if (invoiceIds.length === 0 || valid === invoiceIds.length) return "snapshot";
  return valid === 0 ? "live" : "mixed";
}
/** A statement is overdue starting at midnight UTC on the 11th of the month
 * after the month containing its period end ("after the 10th"). */
export function statementIsOverdue(periodEnd: Date, asOf: Date): boolean {
  // Stored monthly periods use an exclusive end (the first instant of the
  // next month), while manually generated ranges may end on the final instant
  // of the period. Subtracting 1 ms handles both representations.
  const finalPeriodInstant = new Date(periodEnd.getTime() - 1);
  const overdueAt = new Date(
    Date.UTC(
      finalPeriodInstant.getUTCFullYear(),
      finalPeriodInstant.getUTCMonth() + 1,
      11,
    ),
  );
  return asOf.getTime() >= overdueAt.getTime();
}

export function summarizePracticeAccounts(input: {
  invoices: AccountSummaryInvoice[];
  statements: AccountSummaryStatement[];
  practices: AccountSummaryPractice[];
  asOf: Date;
}): PracticeAccountSummary[] {
  const practiceById = new Map(input.practices.map((practice) => [practice.id, practice]));
  const invoiceById = new Map(
    input.invoices
      .filter(
        (invoice) =>
          invoice.providerOrganizationId &&
          !invoice.deletedAt &&
          invoice.status !== "void" &&
          Number(invoice.balanceDue ?? 0) > 0,
      )
      .map((invoice) => [invoice.id, invoice]),
  );
  const practiceIds = new Set<string>();
  for (const invoice of invoiceById.values()) {
    practiceIds.add(invoice.providerOrganizationId!);
  }
  for (const statement of input.statements) {
    practiceIds.add(statement.providerOrganizationId);
  }

  return [...practiceIds].map((practiceId) => {
    const practice = practiceById.get(practiceId);
    const claimedInvoiceIds = new Set<string>();
    const unpaidStatements: PracticeAccountSummary["unpaidStatements"] = [];
    const statements = input.statements
      .filter((statement) => statement.providerOrganizationId === practiceId)
      .sort(
        (a, b) =>
          b.createdAt.getTime() - a.createdAt.getTime() ||
          b.id.localeCompare(a.id),
      );
    const hasLegacyStatements = statements.some(
      (statement) => {
        const ids = Array.isArray(statement.invoiceIdsJson)
          ? statement.invoiceIdsJson.filter((id): id is string => typeof id === "string")
          : [];
        return statementDetailProvenance(ids, statement.invoiceDetailsJson) !== "snapshot";
      },
    );

    for (const statement of statements) {
      const invoiceIds = Array.isArray(statement.invoiceIdsJson)
        ? statement.invoiceIdsJson.filter((id): id is string => typeof id === "string")
        : [];
      let remainingBalance = 0;
      for (const invoiceId of invoiceIds) {
        const invoice = invoiceById.get(invoiceId);
        if (
          !invoice ||
          invoice.providerOrganizationId !== practiceId ||
          claimedInvoiceIds.has(invoiceId)
        ) {
          continue;
        }
        claimedInvoiceIds.add(invoiceId);
        remainingBalance += Number(invoice.balanceDue ?? 0);
      }
      if (remainingBalance <= 0) continue;
      unpaidStatements.push({
        id: statement.id,
        date: statement.createdAt,
        periodStart: statement.periodStart,
        periodEnd: statement.periodEnd,
        remainingBalance,
        overdue: statementIsOverdue(statement.periodEnd, input.asOf),
        detailProvenance:
          statementDetailProvenance(invoiceIds, statement.invoiceDetailsJson),
      });
    }

    const openInvoices = [...invoiceById.values()].filter(
      (invoice) =>
        invoice.providerOrganizationId === practiceId &&
        !claimedInvoiceIds.has(invoice.id),
    );
    const openInvoiceTotal = openInvoices.reduce(
      (sum, invoice) => sum + Number(invoice.balanceDue ?? 0),
      0,
    );
    const statementBalance = unpaidStatements.reduce(
      (sum, statement) => sum + statement.remainingBalance,
      0,
    );
    const overdueBalance = unpaidStatements.reduce(
      (sum, statement) =>
        sum + (statement.overdue ? statement.remainingBalance : 0),
      0,
    );
    // These lifetime figures intentionally include paid and void invoices,
    // matching the invoice-list aggregation formerly performed by Statements.
    const practiceInvoices = input.invoices.filter(
      (invoice) =>
        invoice.providerOrganizationId === practiceId && !invoice.deletedAt,
    );
    const invoiceCount = practiceInvoices.length;
    const totalBilled = practiceInvoices.reduce(
      (sum, invoice) => sum + Number(invoice.total ?? 0),
      0,
    );
    const totalPaid = practiceInvoices.reduce((sum, invoice) => {
      const total = Number(invoice.total ?? 0);
      return sum + Math.max(0, total - Number(invoice.balanceDue ?? 0));
    }, 0);

    return {
      practiceId,
      practiceName: practice?.displayName || practice?.name || "Unknown practice",
      billingEmail: practice?.billingEmail?.trim() || null,
      phone: practice?.phone?.trim() || null,
      openInvoiceCount: openInvoices.length,
      openInvoiceTotal,
      unpaidStatements,
      hasLegacyStatements,
      totalOpenBalance: openInvoiceTotal + statementBalance,
      overdueBalance,
      invoiceCount,
      totalBilled,
      totalPaid,
    };
  });
}

export async function buildPracticeAccountSummaries(
  labOrganizationId: string,
  asOf = new Date(),
): Promise<PracticeAccountSummary[]> {
  const [invoiceRows, statementRows] = await Promise.all([
    db.query.invoices.findMany({
      where: and(
        eq(invoices.labOrganizationId, labOrganizationId),
        isNull(invoices.deletedAt),
        finalizedInvoiceSql(),
      ),
    }),
    db.query.practiceStatements.findMany({
      where: eq(practiceStatements.labOrganizationId, labOrganizationId),
      orderBy: [desc(practiceStatements.createdAt)],
    }),
  ]);
  const practiceIds = [
    ...new Set(
      [
        ...invoiceRows.map((invoice) => invoice.providerOrganizationId),
        ...statementRows.map((statement) => statement.providerOrganizationId),
      ].filter((id): id is string => !!id),
    ),
  ];
  const practices = practiceIds.length
    ? await db
        .select({
          id: organizations.id,
          name: organizations.name,
          displayName: organizations.displayName,
          billingEmail: organizations.billingEmail,
          phone: organizations.phone,
        })
        .from(organizations)
        .where(inArray(organizations.id, practiceIds))
    : [];
  return summarizePracticeAccounts({
    invoices: invoiceRows,
    statements: statementRows,
    practices,
    asOf,
  }).sort((a, b) => a.practiceName.localeCompare(b.practiceName));
}

/**
 * Stream the logo for an org directly from App Storage into a Buffer.
 * Returns null if no logo exists, storage is not configured, or the
 * format is SVG (pdfkit cannot embed SVG natively).
 */
export async function readLogoBuffer(orgId: string): Promise<Buffer | null> {
  try {
    const result = await openLabLogoStream(orgId);
    if (!result) return null;
    if (result.contentType.includes("svg")) return null;
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      result.stream.on("data", (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      result.stream.on("end", resolve);
      result.stream.on("error", reject);
    });
    return Buffer.concat(chunks);
  } catch {
    return null;
  }
}

/**
 * Resolve effective logo placements from a saved preference array.
 * Accepts null/undefined (org not found or column not set) and returns an
 * empty Set so no logo appears until an admin opts in.
 */
function resolveLocalLogoplacements(
  org:
    | {
        logoUrl: string | null | undefined;
        logoplacements: string[] | null | undefined;
      }
    | null
    | undefined
): Set<string> {
  if (!org) return new Set();
  if (org.logoplacements != null) return new Set(org.logoplacements);
  return new Set();
}

function cleanContactValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}
function fmtMoney(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(Number.isFinite(n) ? n : 0);
}
function fmtDiscountLineMoney(n: number): string {
  const magnitude = fmtMoney(Math.abs(Number.isFinite(n) ? n : 0));
  // PDFKit's built-in Helvetica font drops U+2212, so use a supported minus
  // glyph before the currency symbol in statement PDFs.
  return n < 0 ? `-${magnitude}` : magnitude;
}
function fmtDate(d: Date | null | undefined): string {
  if (!d) return "—";
  try {
    return formatNumericDate(d);
  } catch {
    return "—";
  }
}

/** Human-readable labels for the payments.paymentMethod enum, shared with
 * the "Paid On" line rendered on statement PDFs. */
const PAYMENT_METHOD_LABELS: Record<string, string> = {
  check: "Check",
  card: "Card",
  ach: "ACH",
  cash: "Cash",
  other: "Other",
};

export function periodMonthFor(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function priorMonthRange(asOf: Date): {
  start: Date;
  end: Date;
  periodMonth: string;
} {
  const y = asOf.getUTCFullYear();
  const m = asOf.getUTCMonth(); // current month
  const start = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0));
  const end = new Date(Date.UTC(y, m, 1, 0, 0, 0));
  return { start, end, periodMonth: periodMonthFor(start) };
}

/**
 * Batch-fetches invoice line items for every invoice in the given statements
 * and attaches them to the matching invoice entries in-place. The caller
 * passes a Map from invoiceId → {practiceId, invoiceIndex} so this helper
 * can look up the right slot without re-scanning the statements array.
 */
async function attachLineItems(
  statements: Map<string, PracticeStatementData>,
  invoiceIdMap: Map<string, { practiceId: string; index: number }>
): Promise<void> {
  const allIds = Array.from(invoiceIdMap.keys());
  if (!allIds.length) return;

  const liRows = await db.query.invoiceLineItems.findMany({
    where: inArray(invoiceLineItems.invoiceId, allIds),
    orderBy: [asc(invoiceLineItems.sortOrder)],
  });

  const liByInvoice = new Map<string, typeof liRows>();
  for (const li of liRows) {
    if (!liByInvoice.has(li.invoiceId)) liByInvoice.set(li.invoiceId, []);
    liByInvoice.get(li.invoiceId)!.push(li);
  }

  for (const [invoiceId, { practiceId, index }] of invoiceIdMap) {
    const pData = statements.get(practiceId);
    if (!pData) continue;
    const entry = pData.invoices[index];
    if (!entry) continue;
    entry.lineItems = (liByInvoice.get(invoiceId) ?? []).map((li) => ({
      id: li.id,
      description: li.description,
      quantity: li.quantity,
      unitPrice: String(li.unitPrice),
      lineTotal: String(li.lineTotal),
      isDiscount: li.isDiscount,
      parentLineItemId: li.parentLineItemId ?? null,
      toothLabel: li.toothLabel ?? null,
      toothNumber: li.toothNumber ?? null,
      sortOrder: li.sortOrder,
    }));
  }
}

async function attachPayments(
  statements: Map<string, PracticeStatementData>,
  invoiceIdMap: Map<string, { practiceId: string; index: number }>,
): Promise<void> {
  for (const data of statements.values()) {
    data.payments = [];
    data.paidAt = null;
    data.paymentMethod = null;
  }
  const invoiceIds = Array.from(invoiceIdMap.keys());
  if (!invoiceIds.length) return;
  const rows = await db
    .select({
      id: payments.id,
      invoiceId: payments.invoiceId,
      amount: payments.amount,
      paidAt: payments.paidAt,
      paymentMethod: payments.paymentMethod,
      referenceNumber: payments.referenceNumber,
    })
    .from(payments)
    .where(inArray(payments.invoiceId, invoiceIds))
    .orderBy(asc(payments.paidAt), asc(payments.id));
  for (const payment of rows) {
    const group = statements.get(invoiceIdMap.get(payment.invoiceId)?.practiceId ?? "");
    if (!group) continue;
    group.payments!.push({
      id: String(payment.id),
      invoiceId: payment.invoiceId,
      amount: String(payment.amount),
      paidAt: payment.paidAt,
      paymentMethod: payment.paymentMethod,
      referenceNumber: payment.referenceNumber ?? null,
    });
  }
  for (const data of statements.values()) {
    data.payments!.sort(
      (a, b) => a.paidAt.getTime() - b.paidAt.getTime() || a.id.localeCompare(b.id),
    );
    const latest = data.payments!.at(-1);
    data.paidAt = latest?.paidAt ?? null;
    data.paymentMethod = latest?.paymentMethod ?? null;
  }
}
export async function buildPracticeStatements(
  labOrganizationId: string,
  periodStart: Date,
  periodEnd: Date,
  /**
   * When provided (non-null, non-empty), only practices whose id appears in
   * this list will be included in the returned statements. null / undefined
   * means "all practices with activity" — the default behaviour.
   */
  includedOrgIds?: string[] | null
): Promise<PracticeStatementData[]> {
  const rows = await db.query.invoices.findMany({
    where: and(
      eq(invoices.labOrganizationId, labOrganizationId),
      finalizedInvoiceSql(),
      gte(invoices.createdAt, periodStart),
      lt(invoices.createdAt, periodEnd)
    ),
    orderBy: [asc(invoices.createdAt)],
  });
  if (!rows.length) return [];

  // Apply per-practice filter when an explicit inclusion list is present.
  const filterIds =
    includedOrgIds && includedOrgIds.length > 0 ? new Set(includedOrgIds) : null;

  const practiceIds = Array.from(
    new Set(
      rows
        .map((r) => r.providerOrganizationId)
        .filter((id): id is string => id !== null && (!filterIds || filterIds.has(id)))
    )
  );
  if (!practiceIds.length) return [];

  const practiceRows = await db
    .select()
    .from(organizations)
    .where(inArray(organizations.id, practiceIds));
  type OrgRow = (typeof practiceRows)[number];
  const byId = new Map<string, OrgRow>(
    practiceRows.map((o) => [o.id, o] as const)
  );

  const grouped = new Map<string, PracticeStatementData>();
  const invoiceIdMap = new Map<string, { practiceId: string; index: number }>();

  for (const inv of rows) {
    const id = inv.providerOrganizationId;
    // Legacy mobile invoices have no provider org — skip them in statement grouping.
    if (!id) continue;
    // Skip invoices for practices that aren't in the inclusion filter.
    if (filterIds && !filterIds.has(id)) continue;
    const org = byId.get(id);
    const cur =
      grouped.get(id) ||
      ({
        practiceId: id,
        providerOrganizationId: id,
        practiceName: org?.displayName || org?.name || "Unknown practice",
        practiceEmail: org?.billingEmail || null,
        statementEmailOptOut: org?.statementEmailOptOut ?? false,
        invoiceCount: 0,
        totalBilled: 0,
        totalPaid: 0,
        openBalance: 0,
        invoices: [],
      } as PracticeStatementData);

    const total = Number(inv.total ?? 0);
    const balance = Number(inv.balanceDue ?? 0);
    cur.invoiceCount += 1;
    cur.totalBilled += total;
    cur.totalPaid += Math.max(0, total - balance);
    if (inv.status !== "void") cur.openBalance += balance;
    const meta = (inv.displayMetadataJson ?? null) as
      | { patientName?: string | null; billTo?: string | null }
      | null;
    invoiceIdMap.set(inv.id, { practiceId: id, index: cur.invoices.length });
    cur.invoices.push({
      id: inv.id,
      invoiceNumber: inv.invoiceNumber,
      issuedAt: inv.issuedAt ?? inv.createdAt ?? null,
      dueAt: inv.dueAt ?? null,
      status: inv.status,
      total: String(inv.total ?? "0"),
      balanceDue: String(inv.balanceDue ?? "0"),
      patientName: meta?.patientName ?? null,
      billTo: meta?.billTo ?? null,
    });
    grouped.set(id, cur);
  }

  await attachLineItems(grouped, invoiceIdMap);
  await attachPayments(grouped, invoiceIdMap);
  const statements = Array.from(grouped.values());
  await attachStatementContacts(labOrganizationId, statements);
  return statements;
}

const PDF_LOGO_FIT: Record<string, [number, number]> = {
  small: [90, 36],
  medium: [120, 48],
  large: [160, 64],
};

function contactLines(
  contact: StatementContactBlock | null | undefined,
): string[] {
  if (!contact) return [];
  const lines: string[] = [];
  if (contact.displayName) lines.push(contact.displayName);
  if (contact.legalName && contact.legalName !== contact.displayName) {
    lines.push(`Legal name: ${contact.legalName}`);
  }
  for (const value of [
    contact.addressLine1,
    contact.addressLine2,
  ]) {
    if (value) lines.push(value);
  }
  const locality = [contact.city, contact.state, contact.zip].filter(Boolean).join(", ");
  if (locality) lines.push(locality);
  if (contact.phone) lines.push(`Phone: ${contact.phone}`);
  if (contact.billingEmail) lines.push(`Billing email: ${contact.billingEmail}`);
  for (const email of contact.additionalEmails) {
    if (email !== contact.billingEmail) lines.push(`Additional email: ${email}`);
  }
  if (contact.accountNumber) lines.push(`Account #: ${contact.accountNumber}`);
  if (contact.licenseNumber) lines.push(`License #: ${contact.licenseNumber}`);
  return lines;
}
export async function generateStatementPdfBuffer(
  labName: string,
  data: PracticeStatementData,
  periodLabel: string,
  logoBuffer?: Buffer | null,
  logoPdfSize?: string | null,
  invoiceScope?: InvoiceScope,
  invoiceDueDayOfMonth?: number | null,
  footerReplyTo?: string | null,
  footerTextBlocks?: StatementDefaultTextBlock[] | null,
  labOrganizationId?: string | null,
  savedTemplate?: ReturnType<typeof coerceStatementTemplate> | null,
): Promise<Buffer> {
  void labName;
  void logoPdfSize;
  void invoiceScope;
  const template = coerceStatementTemplate(savedTemplate);
  const imageBuffers = await Promise.all(
    template.extraImages.map(async (image) => ({
      image,
      buffer: await readTemplateImageBuffer(labOrganizationId, image.storageKey),
    })),
  );
  const latestIssuedAt = data.invoices.reduce<Date | null>((latest, invoice) => {
    if (!invoice.issuedAt) return latest;
    return !latest || invoice.issuedAt > latest ? invoice.issuedAt : latest;
  }, null);
  const dueDate = invoiceDueDate(
    latestIssuedAt ?? new Date(),
    invoiceDueDayOfMonth ?? 10,
  );

  type PdfRow = {
    text: string;
    amount?: string;
    height: number;
    bold?: boolean;
    color?: string;
  };
  const rows: PdfRow[] = [];
  let runningBalance = 0;
  const invoiceById = new Map(data.invoices.map((invoice) => [invoice.id, invoice]));
  const ledgerEvents = [
    ...data.invoices.map((invoice) => ({
      kind: "invoice" as const,
      invoice,
      date: invoice.issuedAt,
      id: invoice.id,
    })),
    ...(data.payments ?? [])
      .filter((payment) => {
        const invoice = invoiceById.get(payment.invoiceId);
        return invoice !== undefined && invoice.status !== "void";
      })
      .map((payment) => ({
        kind: "payment" as const,
        payment,
        date: payment.paidAt,
        id: payment.id,
      })),
  ].sort((a, b) => {
    const byDate =
      (a.date?.getTime() ?? Number.NEGATIVE_INFINITY) -
      (b.date?.getTime() ?? Number.NEGATIVE_INFINITY);
    if (byDate) return byDate;
    if (a.kind !== b.kind) return a.kind === "invoice" ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
  for (const event of ledgerEvents) {
    if (event.kind === "payment") {
      const invoice = invoiceById.get(event.payment.invoiceId)!;
      const amount = Math.max(0, Number(event.payment.amount) || 0);
      runningBalance = Math.max(0, runningBalance - amount);
      const method =
        PAYMENT_METHOD_LABELS[event.payment.paymentMethod] ??
        event.payment.paymentMethod;
      rows.push({
        text: `Payment — ${invoice.invoiceNumber}  ·  ${fmtDate(event.payment.paidAt)}  ·  ${method}${event.payment.referenceNumber ? `  ·  Ref: ${event.payment.referenceNumber}` : ""}`,
        amount: `${fmtMoney(-amount)}${fmtMoney(runningBalance)}`,
        height: 17,
        color: "#333",
      });
      continue;
    }
    const invoice = event.invoice;
    runningBalance += invoice.status === "void" ? 0 : Number(invoice.total) || 0;
    const billTo = invoice.billTo?.trim();
    let text = [
      invoice.invoiceNumber,
      invoice.patientName?.trim() || "—",
      fmtDate(invoice.issuedAt),
      fmtDate(dueDate),
      invoice.status,
    ].join("  ·  ");
    if (billTo && billTo !== data.practiceName) text += `\nBill to: ${billTo}`;
    rows.push({
      text,
      amount: `${fmtMoney(invoice.status === "void" ? 0 : Number(invoice.total))}${fmtMoney(runningBalance)}`,
      height: billTo && billTo !== data.practiceName ? 28 : 17,
    });
    const parents = (invoice.lineItems ?? []).filter((item) => !item.parentLineItemId);
    const childrenByParent = new Map<string, LineItemEntry[]>();
    for (const item of invoice.lineItems ?? []) {
      if (!item.parentLineItemId) continue;
      const children = childrenByParent.get(item.parentLineItemId) ?? [];
      children.push(item);
      childrenByParent.set(item.parentLineItemId, children);
    }
    for (const parent of parents) {
      const children = childrenByParent.get(parent.id) ?? [];
      rows.push({
        text: `  ${parent.isDiscount ? "Discount: " : ""}${parent.description}`,
        amount: parent.isDiscount
          ? fmtDiscountLineMoney(Number(parent.lineTotal))
          : fmtMoney(Number(parent.lineTotal)),
        height: 14,
        bold: children.length > 0,
        color: "#333",
      });
      for (const child of children) {
        rows.push({
          text: `    ↳ ${child.description}`,
          amount: fmtMoney(Number(child.lineTotal)),
          height: 14,
          color: "#666",
        });
      }
      if (children.length) {
        rows.push({
          text: "  — Subtotal",
          amount: fmtMoney(
            Number(parent.lineTotal) +
              children.reduce((sum, child) => sum + Number(child.lineTotal), 0),
          ),
          height: 15,
          bold: true,
          color: "#555",
        });
      }
    }
  }

  return await new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 0 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const drawImage = (buffer: Buffer | null, box: any, opacity = 1) => {
      if (!buffer) return;
      try {
        const pdfDoc = doc as any;
        if (opacity < 1 && typeof pdfDoc.opacity === "function") pdfDoc.opacity(opacity);
        doc.image(buffer, box.x, box.y, { fit: [box.w, box.h], align: "center", valign: "center" });
        if (opacity < 1 && typeof pdfDoc.opacity === "function") pdfDoc.opacity(1);
      } catch {
        /* decorative image */
      }
    };

    const agingLines = () => {
      const labels = [
        "Current (not overdue)",
        "1–30 days overdue",
        "31–60 days overdue",
        "61–90 days overdue",
        "90+ days overdue",
      ];
      const values = labels.map(() => 0);
      const now = Date.now();
      for (const invoice of data.invoices) {
        const balance = Math.max(0, Number(invoice.balanceDue) || 0);
        if (!balance) continue;
        const days = Math.max(
          0,
          Math.floor((now - (invoice.dueAt?.getTime() ?? now)) / 86400000),
        );
        values[days <= 0 ? 0 : days <= 30 ? 1 : days <= 60 ? 2 : days <= 90 ? 3 : 4] += balance;
      }
      return labels
        .map((label, i) => (values[i]! > 0 ? `${label}: ${fmtMoney(values[i]!)}` : null))
        .filter((line): line is string => line !== null);
    };
    const totalsLines = () => {
      const lines = [
        `Total billed: ${fmtMoney(data.totalBilled)}`,
        `Total paid: ${fmtMoney(data.totalPaid)}`,
        `Balance due: ${fmtMoney(data.openBalance)}`,
      ];
      if (data.recipientType !== "doctor") {
        const byDoctor = new Map<string, number>();
        for (const invoice of data.invoices) {
          const doctor = invoice.billTo?.trim();
          const balance = Number(invoice.balanceDue) || 0;
          if (doctor && balance > 0) byDoctor.set(doctor, (byDoctor.get(doctor) ?? 0) + balance);
        }
        if (byDoctor.size) {
          lines.push("By Doctor");
          for (const [doctor, balance] of byDoctor) lines.push(`${doctor}: ${fmtMoney(balance)}`);
        }
      }
      return lines;
    };
    const footerLines = () => {
      const lines: string[] = [];
      if (footerReplyTo?.trim()) lines.push(`Questions? Contact us at ${footerReplyTo.trim()}`);
      for (const block of footerTextBlocks ?? []) {
        if (block.text?.trim()) lines.push(block.text.trim());
      }
      return lines;
    };

    const recipientLines = data.recipientType === "doctor"
      ? doctorContactLines(data.doctorContact, data.practiceContact)
      : contactLines(data.practiceContact);
    const summaryLines = [
      `Invoices: ${data.invoiceCount}`,
      `Billed: ${fmtMoney(data.totalBilled)}    Paid: ${fmtMoney(data.totalPaid)}    Open balance: ${fmtMoney(data.openBalance)}`,
      `Payment due: ${fmtDate(dueDate)}`,
    ];
    if (data.paidAt) {
      const method = data.paymentMethod ? PAYMENT_METHOD_LABELS[data.paymentMethod] ?? data.paymentMethod : null;
      summaryLines.push(`Paid On: ${fmtDate(data.paidAt)}${method ? ` (${method})` : ""}`);
    }

    const drawSection = (section: StatementTemplateSection) => {
      const title = section.title.trim() || "Section";
      if (section.type === "custom" || section.contentMode === "custom") {
        drawBoundedText(doc, section.box, [title, section.customText?.trim()].filter(Boolean).join("\n"), { fontSize: 8.5 });
        return;
      }
      switch (section.generatedType) {
        case "stmtHeader":
          drawBoundedText(
            doc,
            section.box,
            `${title}\n${labName}\nFor: ${data.practiceName}\nPeriod: ${periodLabel}\nGenerated: ${formatNumericDateTime(new Date())}`,
            { fontSize: 10 },
          );
          break;
        case "labInfo":
          drawBoundedText(doc, section.box, [title, ...contactLines(data.labContact)].join("\n"), { fontSize: 8.5 });
          break;
        case "practiceInfo":
          drawBoundedText(doc, section.box, [title, ...(recipientLines.length ? recipientLines : [data.practiceName])].join("\n"), { fontSize: 8.5 });
          break;
        case "balanceSummary":
          drawBoundedText(doc, section.box, [title, ...summaryLines].join("\n"), { fontSize: 8.5, padding: 3 });
          break;
        case "aging": {
          const lines = agingLines();
          if (lines.length) drawBoundedText(doc, section.box, [title, ...lines].join("\n"), { fontSize: 8 });
          break;
        }
        case "totals":
          drawBoundedText(doc, section.box, [title, ...totalsLines()].join("\n"), { fontSize: 8.5 });
          break;
        case "footer":
          drawBoundedText(doc, section.box, [title, ...footerLines()].join("\n"), { fontSize: 8 });
          break;
      }
    };

    const enabledSections = template.sections.filter((section) => section.enabled);
    const transactionSections = enabledSections.filter(
      (section) =>
        section.type === "generated" &&
        section.contentMode === "generated" &&
        section.generatedType === "transactions",
    );

    const drawStaticSections = () => {
      if (template.logo.mode === "watermark") drawImage(logoBuffer ?? null, template.logo, template.logo.opacity);
      for (const item of imageBuffers) drawImage(item.buffer, item.image, item.image.opacity);
      for (const block of template.customTexts) {
        if (block.text?.trim()) {
          drawBoundedText(doc, block, block.text.trim(), {
            fontSize: block.fontSize,
            font: block.bold ? "Helvetica-Bold" : "Helvetica",
            align: block.align,
          });
        }
      }
      if (template.logo.mode === "header") drawImage(logoBuffer ?? null, template.logo, template.logo.opacity);
      for (const section of enabledSections) {
        if (!transactionSections.some((transaction) => transaction.id === section.id)) drawSection(section);
      }
    };

    const drawTransactionPage = (section: StatementTemplateSection, start: number): number => {
      const box = section.box;
      doc.save();
      doc.rect(box.x, box.y, box.w, box.h).clip();
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#000");
      doc.text(section.title.trim() || "Invoices", box.x + 5, box.y + 4);
      doc.font("Helvetica-Bold").fontSize(7).fillColor("#555");
      doc.text("Invoice / patient / dates / status", box.x + 5, box.y + 21, { width: box.w - 155 });
      doc.text("Amount / Running balance", box.x + box.w - 150, box.y + 21, { width: 145, align: "right" });
      doc.moveTo(box.x + 5, box.y + 32).lineTo(box.x + box.w - 5, box.y + 32).strokeColor("#ccc").stroke();
      let y = box.y + 37;
      let index = start;
      while (index < rows.length && y + rows[index]!.height <= box.y + box.h - 4) {
        const row = rows[index]!;
        doc.font(row.bold ? "Helvetica-Bold" : "Helvetica").fontSize(7.5).fillColor(row.color ?? "#000");
        doc.text(row.text, box.x + 5, y, { width: box.w - 155, height: row.height });
        if (row.amount) doc.text(row.amount, box.x + box.w - 150, y, { width: 145, height: row.height, align: "right" });
        y += row.height;
        index += 1;
      }
      if (index === start && index < rows.length) {
        const row = rows[index]!;
        doc.font(row.bold ? "Helvetica-Bold" : "Helvetica").fontSize(7.5).fillColor(row.color ?? "#000");
        doc.text(row.text, box.x + 5, box.y + 37, { width: box.w - 155, height: row.height });
        if (row.amount) {
          doc.text(row.amount, box.x + box.w - 150, box.y + 37, {
            width: 145,
            height: row.height,
            align: "right",
          });
        }
        index += 1;
      }
      doc.restore();
      return index;
    };

    drawStaticSections();
    let nextRows = transactionSections.map((section) => drawTransactionPage(section, 0));
    while (nextRows.some((next) => next < rows.length)) {
      doc.addPage();
      drawStaticSections();
      nextRows = transactionSections.map((section, index) =>
        nextRows[index]! < rows.length
          ? drawTransactionPage(section, nextRows[index]!)
          : nextRows[index]!,
      );
    }
    doc.end();
  });
}

export async function generateLegacyStatementPdfBuffer(
  labName: string,
  data: PracticeStatementData,
  periodLabel: string,
  logoBuffer?: Buffer | null,
  logoPdfSize?: string | null,
  invoiceScope?: InvoiceScope,
  invoiceDueDayOfMonth?: number | null,
  footerReplyTo?: string | null,
  footerTextBlocks?: StatementDefaultTextBlock[] | null,
  labOrganizationId?: string | null,
  savedTemplate?: ReturnType<typeof coerceStatementTemplate> | null
): Promise<Buffer> {
  // Compute a single statement-level due date: the lab's configured day of
  // month applied to the month AFTER the latest invoice issue date.
  const latestIssuedAt = data.invoices.reduce<Date | null>((latest, inv) => {
    if (!inv.issuedAt) return latest;
    if (!latest || inv.issuedAt > latest) return inv.issuedAt;
    return latest;
  }, null);
  const periodEndDate = latestIssuedAt ?? new Date();
  const statementDueDate = invoiceDueDate(periodEndDate, invoiceDueDayOfMonth ?? 10);

  return await new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 48 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    if (logoBuffer) {
      try {
        const fit = PDF_LOGO_FIT[logoPdfSize ?? "medium"] ?? PDF_LOGO_FIT["medium"]!;
        doc.image(logoBuffer, 48, 30, { fit });
        // Move the cursor below the logo before writing the heading so
        // text does not overlap the image.
        doc.y = 30 + fit[1] + 12;
      } catch {
        // logo embed failed — fall through to text-only header
      }
    }

    doc.fontSize(20).font("Helvetica-Bold").text("Statement", { align: "left" });
    doc.moveDown(0.2);
    doc.fontSize(11).font("Helvetica").fillColor("#444").text(labName);
    doc.fillColor("#000");
    doc.moveDown(0.4);
    doc
      .fontSize(10)
      .fillColor("#666")
      .text(`For: ${data.practiceName}`)
      .text(`Period: ${periodLabel}`)
      .text(`Generated: ${formatNumericDateTime(new Date())}`);
    doc.fillColor("#000");

    doc.moveDown(1);
    doc.fontSize(11).font("Helvetica-Bold").text("Summary");
    doc.moveDown(0.3);
    doc.font("Helvetica").fontSize(10);
    const sumLines: Array<[string, string]> = [
      ["Invoices", String(data.invoiceCount)],
      ["Billed", fmtMoney(data.totalBilled)],
      ["Paid", fmtMoney(data.totalPaid)],
      ["Open balance", fmtMoney(data.openBalance)],
    ];
    if (data.paidAt) {
      const methodLabel = data.paymentMethod
        ? PAYMENT_METHOD_LABELS[data.paymentMethod] ?? data.paymentMethod
        : null;
      sumLines.push([
        "Paid On",
        methodLabel ? `${fmtDate(data.paidAt)} (${methodLabel})` : fmtDate(data.paidAt),
      ]);
    }
    sumLines.push(["Payment due", fmtDate(statementDueDate)]);
    for (const [k, v] of sumLines) {
      doc.text(`${k}: ${v}`);
    }

    doc.moveDown(1);
    doc.fontSize(11).font("Helvetica-Bold").text("Invoices");
    doc.moveDown(0.3);

    const startX = doc.x;
    const colWidths = [110, 100, 75, 75, 60, 70, 70];
    const headers = [
      "Invoice",
      "Patient",
      "Issued",
      "Due",
      "Status",
      "Total",
      "Balance",
    ];
    const rightAlignFrom = 5;
    let y = doc.y;
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#444");
    let x = startX;
    headers.forEach((h, i) => {
      doc.text(h, x, y, {
        width: colWidths[i],
        align: i >= rightAlignFrom ? "right" : "left",
      });
      x += colWidths[i]!;
    });
    doc.fillColor("#000");
    y += 14;
    doc
      .moveTo(startX, y - 2)
      .lineTo(startX + colWidths.reduce((a, b) => a + b!, 0), y - 2)
      .strokeColor("#ccc")
      .stroke();

    const tableWidth = colWidths.reduce((a, b) => a + b, 0);

    doc.font("Helvetica").fontSize(9);
    for (const inv of data.invoices) {
      const billTo = inv.billTo && inv.billTo.trim() ? inv.billTo.trim() : "";
      const showBillTo = billTo && billTo !== data.practiceName;
      const rowHeight = showBillTo ? 26 : 16;
      if (y + rowHeight > doc.page.height - 60) {
        doc.addPage();
        y = doc.y;
      }
      const patient =
        inv.patientName && inv.patientName.trim() ? inv.patientName.trim() : "—";
      const cells = [
        inv.invoiceNumber,
        patient,
        fmtDate(inv.issuedAt),
        // Use the statement-level due date for every row so all invoices
        // show the same consistent date regardless of per-invoice dueAt.
        fmtDate(statementDueDate),
        inv.status,
        fmtMoney(Number(inv.total)),
        fmtMoney(Number(inv.balanceDue)),
      ];
      x = startX;
      cells.forEach((c, i) => {
        doc.text(c, x, y, {
          width: colWidths[i],
          align: i >= rightAlignFrom ? "right" : "left",
        });
        x += colWidths[i]!;
      });
      if (showBillTo) {
        doc
          .fontSize(8)
          .fillColor("#666")
          .text(`Bill to: ${billTo}`, startX, y + 12, {
            width: colWidths[0]!,
          });
        doc.fontSize(9).fillColor("#000");
      }
      y += rowHeight;

      // ── Grouped line items ──────────────────────────────────────────────
      const lineItems = inv.lineItems;
      if (lineItems && lineItems.length > 0) {
        const LI_INDENT = 16;
        const LI_AMT_W = 70;
        const LI_DESC_W = tableWidth - LI_INDENT - LI_AMT_W;
        const liX = startX + LI_INDENT;
        const liAmtX = liX + LI_DESC_W;

        // Separate top-level items from children.
        const parents = lineItems.filter((li) => !li.parentLineItemId);
        const childrenByParent = new Map<string, LineItemEntry[]>();
        for (const li of lineItems) {
          if (li.parentLineItemId) {
            if (!childrenByParent.has(li.parentLineItemId)) {
              childrenByParent.set(li.parentLineItemId, []);
            }
            childrenByParent.get(li.parentLineItemId)!.push(li);
          }
        }

        for (const parent of parents) {
          const children = childrenByParent.get(parent.id) ?? [];
          const hasChildren = children.length > 0;
          const LI_ROW_H = 13;

          // Parent / group-header row
          if (y + LI_ROW_H > doc.page.height - 60) {
            doc.addPage();
            y = doc.y;
          }
          doc
            .font(hasChildren ? "Helvetica-Bold" : "Helvetica")
            .fontSize(8)
            .fillColor("#333");
          doc.text(
            `${parent.isDiscount ? "Discount: " : ""}${parent.description}`,
            liX,
            y,
            { width: LI_DESC_W, lineBreak: false },
          );
          doc.text(
            parent.isDiscount
              ? fmtDiscountLineMoney(Number(parent.lineTotal))
              : fmtMoney(Number(parent.lineTotal)),
            liAmtX,
            y,
            {
            width: LI_AMT_W,
            align: "right",
            lineBreak: false,
            },
          );
          doc.fillColor("#000");
          y += LI_ROW_H;

          // Child rows (sub-items)
          const SUB_EXTRA = 10;
          const subX = liX + SUB_EXTRA;
          const subDescW = LI_DESC_W - SUB_EXTRA;
          for (const child of children) {
            if (y + LI_ROW_H > doc.page.height - 60) {
              doc.addPage();
              y = doc.y;
            }
            doc.font("Helvetica").fontSize(8).fillColor("#666");
            doc.text(`↳ ${child.description}`, subX, y, {
              width: subDescW,
              lineBreak: false,
            });
            doc.text(fmtMoney(Number(child.lineTotal)), liAmtX, y, {
              width: LI_AMT_W,
              align: "right",
              lineBreak: false,
            });
            doc.fillColor("#000");
            y += LI_ROW_H;
          }

          // Subtotal row when parent has children
          if (hasChildren) {
            const groupTotal =
              Number(parent.lineTotal) +
              children.reduce((s, c) => s + Number(c.lineTotal), 0);
            const ST_ROW_H = 14;
            if (y + ST_ROW_H > doc.page.height - 60) {
              doc.addPage();
              y = doc.y;
            }
            // Light-gray background strip
            doc.save();
            doc
              .rect(startX + LI_INDENT - 4, y - 2, tableWidth - LI_INDENT + 4, ST_ROW_H + 1)
              .fillColor("#e6e8eb")
              .fill();
            doc.restore();
            // "— Subtotal" label (italic) + bold amount
            doc.font("Helvetica-Oblique").fontSize(8).fillColor("#505050");
            doc.text("— Subtotal", liX, y, { width: LI_DESC_W, lineBreak: false });
            doc.font("Helvetica-Bold").fillColor("#505050");
            doc.text(fmtMoney(groupTotal), liAmtX, y, {
              width: LI_AMT_W,
              align: "right",
              lineBreak: false,
            });
            doc.fillColor("#000");
            y += ST_ROW_H;
          }
        }
        // Small visual gap after the line-items block
        y += 4;
      }
      // ── End grouped line items ──────────────────────────────────────────
    }

    // ── Aging summary ─────────────────────────────────────────────────────
    // Render whenever any invoice carries an open balance > 0.
    const hasOpenBalance = data.invoices.some(
      (inv) => inv.status !== "paid" && inv.status !== "void" && Number(inv.balanceDue) > 0
    );
    if (hasOpenBalance) {
      const now = new Date();
      const buckets = { current: 0, d30: 0, d60: 0, d90: 0, d90plus: 0 };
      for (const inv of data.invoices) {
        if (inv.status === "paid" || inv.status === "void") continue;
        const balance = Number(inv.balanceDue);
        if (balance <= 0) continue;
        if (!inv.dueAt) { buckets.current += balance; continue; }
        const daysOverdue = Math.floor(
          (now.getTime() - new Date(inv.dueAt).getTime()) / 86400000
        );
        if (daysOverdue <= 0) buckets.current += balance;
        else if (daysOverdue <= 30) buckets.d30 += balance;
        else if (daysOverdue <= 60) buckets.d60 += balance;
        else if (daysOverdue <= 90) buckets.d90 += balance;
        else buckets.d90plus += balance;
      }

      const ageRows: Array<{ label: string; amount: number; highlight?: boolean }> = [
        { label: "Current (not overdue)", amount: buckets.current },
        { label: "1\u201330 days overdue", amount: buckets.d30 },
        { label: "31\u201360 days overdue", amount: buckets.d60 },
        { label: "61\u201390 days overdue", amount: buckets.d90 },
        { label: "90+ days overdue", amount: buckets.d90plus, highlight: true },
      ].filter((r) => r.amount > 0);

      if (ageRows.length > 0) {
        const SECTION_H = 32 + ageRows.length * 14 + 10;
        if (y + SECTION_H > doc.page.height - 60) {
          doc.addPage();
          y = doc.y;
        }
        y += 16;
        doc.fontSize(11).font("Helvetica-Bold").fillColor("#000").text("Aging Summary", startX, y);
        y += 16;
        doc.font("Helvetica-Bold").fontSize(9).fillColor("#444");
        doc.text("Age bucket", startX, y, { width: 220 });
        doc.text("Balance due", startX + 220, y, { width: 110, align: "right" });
        doc.fillColor("#000");
        y += 13;
        doc
          .moveTo(startX, y - 2)
          .lineTo(startX + 330, y - 2)
          .strokeColor("#ccc")
          .stroke();
        doc.font("Helvetica").fontSize(9);
        for (const row of ageRows) {
          if (y + 14 > doc.page.height - 60) {
            doc.addPage();
            y = doc.y;
          }
          if (row.highlight) doc.fillColor("#c00000");
          doc.text(row.label, startX, y, { width: 220 });
          doc.text(fmtMoney(row.amount), startX + 220, y, { width: 110, align: "right" });
          if (row.highlight) doc.fillColor("#000");
          y += 14;
        }
      }
    }

    // ── Totals block ─────────────────────────────────────────────────────
    {
      const TOTALS_W = 200;
      const TOTALS_H = 56;
      const totalsX = startX + tableWidth - TOTALS_W;
      if (y + TOTALS_H + 20 > doc.page.height - 60) {
        doc.addPage();
        y = doc.y;
      }
      y += 16;
      // Light background box
      doc.save();
      doc.rect(totalsX - 8, y - 4, TOTALS_W + 8, TOTALS_H).fillColor("#f3f4f6").fill();
      doc.restore();
      doc.fontSize(11).font("Helvetica-Bold").fillColor("#000").text("Totals", totalsX, y, { width: TOTALS_W });
      y += 16;
      const totalsRows: Array<[string, string, boolean]> = [
        ["Billed", fmtMoney(data.totalBilled), false],
        ["Paid", fmtMoney(data.totalPaid), false],
        ["Open balance", fmtMoney(data.openBalance), true],
      ];
      doc.fontSize(9);
      for (const [label, amount, bold] of totalsRows) {
        doc.font(bold ? "Helvetica-Bold" : "Helvetica").fillColor("#000");
        doc.text(label, totalsX, y, { width: TOTALS_W - 70, lineBreak: false });
        doc.font(bold ? "Helvetica-Bold" : "Helvetica");
        doc.text(amount, totalsX + TOTALS_W - 70, y, { width: 70, align: "right", lineBreak: false });
        y += 13;
      }
    }

    // ── By Doctor breakdown (practice-wide statements only) ──────────────
    if (data.recipientType !== "doctor") {
      const doctorMap = new Map<string, number>();
      for (const inv of data.invoices) {
        if (inv.status === "void") continue;
        const balance = Number(inv.balanceDue);
        if (balance <= 0) continue;
        const doctor = inv.billTo?.trim();
        if (!doctor) continue;
        doctorMap.set(doctor, (doctorMap.get(doctor) ?? 0) + balance);
      }
      if (doctorMap.size > 0) {
        const doctorRows = Array.from(doctorMap.entries())
          .sort((a, b) => b[1] - a[1]);
        const DRBD_W = 260;
        const DRBD_ROW_H = 13;
        const DRBD_SECTION_H = 32 + doctorRows.length * DRBD_ROW_H + 10;
        const drX = startX + tableWidth - DRBD_W;
        if (y + DRBD_SECTION_H + 16 > doc.page.height - 60) {
          doc.addPage();
          y = doc.y;
        }
        y += 16;
        doc.fontSize(11).font("Helvetica-Bold").fillColor("#000").text("By Doctor", drX, y, { width: DRBD_W });
        y += 16;
        doc.font("Helvetica-Bold").fontSize(9).fillColor("#444");
        doc.text("Doctor", drX, y, { width: DRBD_W - 80, lineBreak: false });
        doc.text("Balance", drX + DRBD_W - 80, y, { width: 80, align: "right", lineBreak: false });
        doc.fillColor("#000");
        y += 13;
        doc.moveTo(drX, y - 2).lineTo(drX + DRBD_W, y - 2).strokeColor("#ccc").stroke();
        doc.font("Helvetica").fontSize(9);
        for (const [doctor, balance] of doctorRows) {
          if (y + DRBD_ROW_H > doc.page.height - 60) {
            doc.addPage();
            y = doc.y;
          }
          doc.text(doctor, drX, y, { width: DRBD_W - 80, lineBreak: false });
          doc.text(fmtMoney(balance), drX + DRBD_W - 80, y, { width: 80, align: "right", lineBreak: false });
          y += DRBD_ROW_H;
        }
      }
    }

    // ── Footer / Notes ────────────────────────────────────────────────────
    {
      const FOOTER_MIN_H = 30;
      if (y + FOOTER_MIN_H > doc.page.height - 30) {
        doc.addPage();
        y = doc.y;
      }
      y += 16;
      doc.moveTo(startX, y).lineTo(startX + tableWidth, y).strokeColor("#ccc").stroke();
      y += 8;

      const replyTo = footerReplyTo?.trim();
      if (replyTo) {
        doc.font("Helvetica").fontSize(9).fillColor("#444")
          .text(`Questions? Contact us at ${replyTo}`, startX, y, { width: tableWidth });
        y += 13;
      }

      if (footerTextBlocks && footerTextBlocks.length > 0) {
        for (const block of footerTextBlocks) {
          if (!block.text?.trim()) continue;
          if (y + 13 > doc.page.height - 20) {
            doc.addPage();
            y = doc.y;
          }
          doc
            .font(block.bold ? "Helvetica-Bold" : "Helvetica")
            .fontSize(block.fontSize ?? 9)
            .fillColor("#444")
            .text(block.text.trim(), startX, y, {
              width: tableWidth,
              align: block.align ?? "left",
            });
          y += (block.fontSize ?? 9) + 4;
        }
      }

      // Preserve the layout with blank space if nothing was written
      if (!replyTo && (!footerTextBlocks || footerTextBlocks.length === 0)) {
        y += 20;
      }
    }

    doc.end();
  });
}
export const DEFAULT_STATEMENT_SUBJECT =
  "Statement for {{practiceName}} — {{periodLabel}}";

export const DEFAULT_STATEMENT_BODY_PRACTICE =
  "Hello {{practiceName}},\n\nPlease find attached the statement for {{practiceName}} covering {{periodLabel}}.\n\nThank you,\n{{labName}}";
/** Backwards-compatible alias for the practice-recipient default. */
export const DEFAULT_STATEMENT_BODY = DEFAULT_STATEMENT_BODY_PRACTICE;

export function defaultStatementBody(
  recipientType: "practice" | "doctor" = "practice"
): string {
  return recipientType === "doctor"
    ? DEFAULT_STATEMENT_BODY_DOCTOR
    : DEFAULT_STATEMENT_BODY_PRACTICE;
}
export interface StatementEmailVars {
  practiceName: string;
  /** Doctor name in doctor-recipient mode; empty string in practice mode. */
  doctorName: string;
  labName: string;
  periodLabel: string;
  totalBilled: string;
  openBalance: string;
}

export function renderStatementTemplate(
  template: string,
  vars: StatementEmailVars
): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key: string) => {
    const v = (vars as unknown as Record<string, string>)[key];
    return v ?? `{{${key}}}`;
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function bodyToHtml(body: string): string {
  const escaped = escapeHtml(body).replace(/\n/g, "<br/>");
  return `<div style="font-family: Arial, sans-serif; max-width: 600px; white-space: normal;">${escaped}</div>`;
}

export async function sendStatementEmail(opts: {
  to: string;
  /** Additional CC recipients (e.g. billing-type additional emails on the practice). */
  cc?: string[] | null;
  fromName: string;
  practiceName: string;
  recipientType?: "practice" | "doctor";
  /** Doctor name when sending a doctor-recipient statement; omitted otherwise. */
  doctorName?: string | null;
  periodLabel: string;
  /** Single-PDF callers (doctor mode, scheduler, legacy resends). */
  pdfBuffer?: Buffer;
  pdfFilename?: string;
  /**
   * Multi-PDF callers (practice bundles): every statement document attached
   * to one practice message. Takes precedence over pdfBuffer/pdfFilename.
   */
  attachments?: Array<{ filename: string; content: Buffer }> | null;
  totals: { billed: number; open: number };
  template?: {
    subject?: string | null;
    body?: string | null;
    replyTo?: string | null;
    /** Optional bold header line rendered above the body. */
    header?: string | null;
  } | null;
  /**
   * When set, an <img> tag with the lab logo is prepended to the email HTML.
   * Must be an absolute URL. Only populated when the `emails` placement is
   * enabled for the lab.
   */
  labLogoUrl?: string | null;
  labLogo?: { content: Buffer; contentType: string } | null;
}): Promise<{ delivered: boolean; reason?: string }> {
  const vars: StatementEmailVars = {
    practiceName: opts.practiceName,
    doctorName: opts.doctorName?.trim() || "",
    labName: opts.fromName,
    periodLabel: opts.periodLabel,
    totalBilled: fmtMoney(opts.totals.billed),
    openBalance: fmtMoney(opts.totals.open),
  };
  const recipientType =
    opts.recipientType ?? (opts.doctorName?.trim() ? "doctor" : "practice");
  const subjectTemplate =
    (opts.template?.subject?.trim() || "") || DEFAULT_STATEMENT_SUBJECT;
  const bodyTemplate =
    (opts.template?.body?.trim() || "") || defaultStatementBody(recipientType);
  const subject = renderStatementTemplate(subjectTemplate, vars);
  const bodyText = renderStatementTemplate(bodyTemplate, vars);
  const replyTo = opts.template?.replyTo?.trim() || undefined;
  const headerText = opts.template?.header?.trim()
    ? renderStatementTemplate(opts.template.header.trim(), vars)
    : "";

  const logoHeaderHtml = opts.labLogo
    ? `<div style="margin-bottom:12px;"><img src="cid:${LAB_LOGO_CID}" alt="Lab logo" style="max-height:48px;max-width:150px;object-fit:contain;display:block;" /></div>`
    : opts.labLogoUrl
      ? `<div style="margin-bottom:12px;"><img src="${escapeHtml(opts.labLogoUrl)}" alt="Lab logo" style="max-height:48px;max-width:150px;object-fit:contain;display:block;" /></div>`
    : "";
  const titleHtml = headerText
    ? `<div style="font-weight:bold;font-size:16px;margin-bottom:12px;">${escapeHtml(headerText)}</div>`
    : "";
  const bodyInner = bodyToHtml(bodyText)
    .replace(/^<div[^>]*>/, "")
    .replace(/<\/div>$/, "");
  const emailHtml =
    logoHeaderHtml || titleHtml
      ? `<div style="font-family:Arial,sans-serif;max-width:600px;">${logoHeaderHtml}${titleHtml}${bodyInner}</div>`
      : bodyToHtml(bodyText);

  const pdfAttachments =
    opts.attachments && opts.attachments.length
      ? opts.attachments
      : opts.pdfBuffer && opts.pdfFilename
        ? [{ filename: opts.pdfFilename, content: opts.pdfBuffer }]
        : [];
  if (!pdfAttachments.length) {
    throw new Error("Statement email requires at least one PDF attachment.");
  }

  const result = await sendMail({
    fromName: opts.fromName,
    to: opts.to,
    subject,
    text: bodyText,
    html: emailHtml,
    cc: opts.cc,
    replyTo,
    attachments: [
      ...pdfAttachments.map((attachment) => ({
        filename: attachment.filename,
        content: attachment.content,
        contentType: "application/pdf",
      })),
      ...(opts.labLogo
        ? [{
            filename: "lab-logo",
            content: opts.labLogo.content,
            contentType: opts.labLogo.contentType,
            cid: LAB_LOGO_CID,
            contentDisposition: "inline" as const,
          }]
        : []),
    ],
  });
  return { delivered: result.sent, ...(result.reason ? { reason: result.reason } : {}) };
}

/**
 * Batch-fetch billing-type additional emails for a set of provider org IDs.
 * Returns a Map<orgId, email[]> containing only orgs that have at least one
 * billing-tagged additional address.
 */
async function getBillingAdditionalEmailsMap(
  orgIds: string[]
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (orgIds.length === 0) return map;
  const rows = await db
    .select({
      organizationId: organizationAdditionalEmails.organizationId,
      email: organizationAdditionalEmails.email,
    })
    .from(organizationAdditionalEmails)
    .where(
      and(
        inArray(organizationAdditionalEmails.organizationId, orgIds),
        eq(organizationAdditionalEmails.type, "billing")
      )
    );
  for (const row of rows) {
    const list = map.get(row.organizationId) ?? [];
    list.push(row.email);
    map.set(row.organizationId, list);
  }
  return map;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** True when the value looks like a deliverable address. */
export function isLikelyEmailAddress(value: string): boolean {
  return EMAIL_PATTERN.test(value.trim());
}

/**
 * Trims, drops blanks, and removes duplicates case-insensitively while
 * preserving first-seen order. Used everywhere a recipient list is assembled
 * so the same address can never be emailed twice.
 */
export function normalizeEmailList(
  values: Array<string | null | undefined>
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = (raw ?? "").trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/**
 * Saved billing recipients for each practice: the primary billing email
 * followed by every billing-tagged additional address. Correspondence-only
 * contacts are deliberately excluded — they are not billing recipients.
 */
export async function getPracticeBillingRecipientsMap(
  orgs: Array<{ id: string; billingEmail: string | null }>
): Promise<Map<string, string[]>> {
  const ids = [...new Set(orgs.map((o) => o.id))];
  const additional = await getBillingAdditionalEmailsMap(ids);
  const map = new Map<string, string[]>();
  for (const org of orgs) {
    map.set(
      org.id,
      normalizeEmailList([org.billingEmail, ...(additional.get(org.id) ?? [])])
    );
  }
  return map;
}

function periodLabel(periodMonth: string): string {
  const [y, m] = periodMonth.split("-").map((s) => parseInt(s, 10));
  if (!y || !m) return periodMonth;
  const d = new Date(Date.UTC(y, m - 1, 1));
  return formatNumericMonthYear(d);
}

export interface RunResultRow {
  practiceId: string;
  practiceName: string;
  practiceEmail: string | null;
  status: "sent" | "failed" | "skipped_no_email" | "skipped_opted_out";
  errorMessage?: string;
}

export async function runMonthlyStatementsForLab(opts: {
  labOrganizationId: string;
  triggeredBy: SendTrigger;
  triggeredByUserId?: string | null;
  asOf?: Date;
}): Promise<{ periodMonth: string; results: RunResultRow[] }> {
  const asOf = opts.asOf ?? new Date();
  const { start, end, periodMonth } = priorMonthRange(asOf);
  const labOrg = await db.query.organizations.findFirst({
    where: eq(organizations.id, opts.labOrganizationId),
  });
  const labName = labOrg?.displayName || labOrg?.name || "LabTrax";

  // Determine which logo contexts are active for this lab.
  const effectivePlacements = resolveLocalLogoplacements(labOrg);
  const logoBuffer = effectivePlacements.has("statements")
    ? await readLogoBuffer(opts.labOrganizationId)
    : null;
  const emailLogoUrl =
    effectivePlacements.has("emails") && labOrg?.logoUrl
      ? `${getAppBaseUrl()}${labOrg.logoUrl}`
      : null;

  const sched = await db.query.statementSchedules.findFirst({
    where: eq(statementSchedules.labOrganizationId, opts.labOrganizationId),
  });
  const template = sched
    ? {
        subject: sched.emailSubject,
        body: sched.emailBody,
        replyTo: sched.emailReplyTo,
      }
    : null;

  // Respect the per-practice inclusion filter saved on the schedule.
  // null / empty → send to all practices with activity (default behaviour).
  const includedOrgIds =
    sched?.includedOrgIds && sched.includedOrgIds.length > 0
      ? sched.includedOrgIds
      : null;

  const usePracticeBundles = sched?.statementFormat !== "consolidated";
  const monthlyUnits: Array<{
    summary: PracticeStatementData;
    documents: Array<{
      documentKey: string;
      doctorName: string | null;
      label: string;
      data: PracticeStatementData;
    }>;
    isBundle: boolean;
  }> = usePracticeBundles
    ? (
        await buildPracticeStatementBundles(opts.labOrganizationId, {
          scope: "all",
          practiceIds: includedOrgIds,
          createdAtRange: { start, endExclusive: end },
        })
      ).map((bundle) => ({
        summary: bundle.practice,
        documents: bundle.documents.map((document) => ({
          documentKey: document.documentKey,
          doctorName: document.doctorName,
          label: document.label,
          data: document.data,
        })),
        isBundle: true,
      }))
    : (
        await buildPracticeStatements(
          opts.labOrganizationId,
          start,
          end,
          includedOrgIds
        )
      ).map((statement) => ({
        summary: statement,
        documents: [
          {
            documentKey: statement.practiceId,
            doctorName: null,
            label: statement.practiceName,
            data: statement,
          },
        ],
        isBundle: false,
      }));

  // Batch-fetch billing additional emails for all practices so they can be
  // included as CC recipients on each send.
  const monthlyBillingCcMap = await getBillingAdditionalEmailsMap(
    monthlyUnits.map((unit) => unit.summary.practiceId).filter(Boolean)
  );

  const results: RunResultRow[] = [];
  const statementTemplate = coerceStatementTemplate(
    (labOrg as any)?.statementTemplate
  );
  for (const unit of monthlyUnits) {
    const s = unit.summary;
    const safeName = s.practiceName.replace(/[^a-z0-9-_]+/gi, "_");
    let status: RunResultRow["status"] = "sent";
    let errorMessage: string | undefined;
    let monthlyPersistedPdf: {
      storageKey: string;
      fileName: string;
      size: number;
    } | null = null;
    let issuedStatementId: string | null = null;
    let rendered: RenderedStatementDocument[] = [];
    const monthlyCc = monthlyBillingCcMap.get(s.practiceId) ?? null;
    const bundleRecipients = [
      s.practiceEmail,
      ...(monthlyCc ?? []),
    ].filter((email): email is string => !!email);

    try {
      if (s.statementEmailOptOut) {
        status = "skipped_opted_out";
        errorMessage = "Practice has opted out of statement emails";
      } else if (!s.practiceEmail) {
        status = "skipped_no_email";
        errorMessage = "Practice has no billing email on file";
      } else if (!(await checkEmailPref(s.practiceEmail, "statementEmails"))) {
        status = "skipped_opted_out";
        errorMessage = "Recipient has opted out of statement emails via notification preferences";
      } else {
        const nextFileName = createStatementFileNamer();
        for (const document of unit.documents) {
          const pdfBuffer = await generateStatementPdfBuffer(
            labName,
            document.data,
            periodLabel(periodMonth),
            logoBuffer,
            (labOrg as any)?.logoPdfSize,
            undefined,
            labOrg?.invoiceDueDayOfMonth ?? null,
            sched?.emailReplyTo ?? null,
            statementTemplate.defaultTextBlocks,
            opts.labOrganizationId,
            statementTemplate
          );
          const baseName = unit.isBundle
            ? `statement-${safeName}-${sanitizeStatementFileNamePart(document.label)}-${periodMonth}`
            : `statement-${safeName}-${periodMonth}`;
          rendered.push({
            documentKey: document.documentKey,
            doctorName: document.doctorName,
            label: document.label,
            fileName: unit.isBundle
              ? nextFileName(baseName)
              : `${baseName}.pdf`,
            buffer: pdfBuffer,
            data: document.data,
          });
        }

        if (unit.isBundle && s.providerOrganizationId) {
          const persistedAttachments = await persistBundleAttachmentsOrThrow({
            providerOrganizationId: s.providerOrganizationId,
            periodMonth,
            rendered,
          });
          issuedStatementId = await issueStatementBundleRecordOrThrow({
            labOrganizationId: opts.labOrganizationId,
            providerOrganizationId: s.providerOrganizationId,
            summary: s,
            attachments: persistedAttachments,
            recipients: bundleRecipients,
            periodMonth,
            from: start,
            to: end,
            asOf: null,
            createdByUserId: opts.triggeredByUserId ?? null,
          });
        } else if (!unit.isBundle && s.providerOrganizationId) {
          // Preserve the original consolidated scheduler's best-effort
          // persistence behavior for labs that explicitly retain that format.
          try {
            const pdf = rendered[0]!;
            monthlyPersistedPdf = await persistStatementPdf({
              buffer: pdf.buffer,
              providerOrganizationId: s.providerOrganizationId,
              periodMonth,
            });
          } catch (persistErr: unknown) {
            logger.warn(
              { err: persistErr, practiceId: s.practiceId },
              "Monthly statement: PDF persist failed, skipping practiceStatements insert"
            );
          }
        }

        const result = await sendStatementEmail({
          to: s.practiceEmail,
          cc: monthlyCc,
          fromName: labName,
          practiceName: s.practiceName,
          periodLabel: periodLabel(periodMonth),
          ...(unit.isBundle
            ? {
                attachments: rendered.map((document) => ({
                  filename: document.fileName,
                  content: document.buffer,
                })),
              }
            : {
                pdfBuffer: rendered[0]!.buffer,
                pdfFilename: rendered[0]!.fileName,
              }),
          totals: { billed: s.totalBilled, open: s.openBalance },
          template,
          labLogoUrl: emailLogoUrl,
        });
        if (!result.delivered) {
          status = "failed";
          errorMessage = result.reason || "Email send failed";
        }
      }
    } catch (err: unknown) {
      status = "failed";
      errorMessage = err instanceof Error ? err.message : String(err);
      logger.error(
        { err, practiceId: s.practiceId },
        "Statement send failed"
      );
    }

    const now = new Date();
    const delay = status === "failed" ? nextAttemptDelayMs(1) : null;
    await db.insert(statementSendRuns).values({
      labOrganizationId: opts.labOrganizationId,
      practiceOrganizationId: s.practiceId,
      practiceName: s.practiceName,
      practiceEmail: s.practiceEmail,
      periodMonth,
      status,
      errorMessage: errorMessage ?? null,
      invoiceCount: s.invoiceCount,
      totalBilled: s.totalBilled.toFixed(2),
      openBalance: s.openBalance.toFixed(2),
      triggeredBy: opts.triggeredBy,
      triggeredByUserId: opts.triggeredByUserId ?? null,
      attemptCount: 1,
      lastAttemptAt: now,
      nextAttemptAt: delay !== null ? new Date(now.getTime() + delay) : null,
      ...(unit.isBundle
        ? {
            bundleContextJson: {
              version: 1 as const,
              statementId: issuedStatementId,
              recipients: bundleRecipients,
              periodLabel: periodLabel(periodMonth),
              documentKeys: unit.documents.map((document) => document.documentKey),
              emailSubject: template?.subject ?? null,
              emailBody: template?.body ?? null,
              emailHeader: null,
              emailReplyTo: template?.replyTo ?? null,
            } satisfies StatementSendRunBundleContext,
          }
        : {}),
    });

    // Insert practiceStatements + practiceStatementSends so the Statements
    // tab reflects the monthly send.
    const monthlyProvOrgId = s.providerOrganizationId ?? null;
    if (unit.isBundle && issuedStatementId && monthlyProvOrgId) {
      for (const recipient of bundleRecipients) {
        await db
          .insert(practiceStatementSends)
          .values({
            statementId: issuedStatementId,
            channel: "email",
            recipient,
            status: status === "sent" ? "sent" : "failed",
            errorMessage: errorMessage ?? null,
            sentByUserId: (opts.triggeredByUserId ?? null) as string,
          })
          .catch((insertErr: unknown) => {
            logger.warn(
              { err: insertErr, practiceId: s.practiceId },
              "Monthly statement: send history insert failed"
            );
          });
      }
    } else if (monthlyPersistedPdf && monthlyProvOrgId) {
      try {
        const [stmt] = await db
          .insert(practiceStatements)
          .values({
            labOrganizationId: opts.labOrganizationId,
            providerOrganizationId: monthlyProvOrgId,
            periodStart: start,
            periodEnd: end,
            invoiceCount: s.invoiceCount,
            totalBilled: s.totalBilled.toFixed(2),
            totalPaid: s.totalPaid.toFixed(2),
            balanceDue: s.openBalance.toFixed(2),
            invoiceIdsJson: s.invoices.map((i) => i.id),
            invoiceAmountsJson: Object.fromEntries(
              s.invoices.map((invoice) => [invoice.id, invoice.total]),
            ),
            invoiceDetailsJson: statementInvoiceDetails(s.invoices),
            pdfStorageKey: monthlyPersistedPdf.storageKey,
            pdfFileName: monthlyPersistedPdf.fileName,
            pdfFileSize: monthlyPersistedPdf.size,
            // Drizzle's insert type requires string but the column is nullable;
            // the cast is safe — Drizzle passes the runtime value as-is.
            createdByUserId: (opts.triggeredByUserId ?? null) as string,
          })
          .returning();
        if (stmt && s.practiceEmail) {
          await db.insert(practiceStatementSends).values({
            statementId: stmt.id,
            channel: "email",
            recipient: s.practiceEmail,
            status: status === "sent" ? "sent" : "failed",
            errorMessage: errorMessage ?? null,
            sentByUserId: (opts.triggeredByUserId ?? null) as string,
          });
        }
      } catch (insertErr: unknown) {
        logger.warn(
          { err: insertErr, practiceId: s.practiceId },
          "Monthly statement: practiceStatements insert failed"
        );
      }
    }

    results.push({
      practiceId: s.practiceId,
      practiceName: s.practiceName,
      practiceEmail: s.practiceEmail,
      status,
      errorMessage,
    });
  }

  return { periodMonth, results };
}

// ── Retry of individual failed sends ────────────────────────────────────────
// statementSendRuns rows that ended in `failed` keep their `nextAttemptAt`
// stamp until the configured maximum attempts is reached. The retry tick
// (and the manual /retry route) re-builds the PDF from current invoice data
// for the same period and re-sends to the same address.

export interface RetryResult {
  runId: string;
  status: "sent" | "failed" | "skipped_no_email" | "skipped_opted_out";
  attemptCount: number;
  errorMessage?: string;
}

/**
 * Reads the issued PDFs of a bundle back from disk. Returns null when any one
 * of them is missing or empty: a bundle goes out whole or not at all, so a
 * partial re-send is never attempted.
 */
function loadIssuedBundleAttachments(
  manifest: StatementBundleManifest
): Array<{ filename: string; content: Buffer }> | null {
  const out: Array<{ filename: string; content: Buffer }> = [];
  for (const attachment of manifest.attachments) {
    try {
      const safeKey = path.basename(attachment.storageKey);
      const filePath = path.resolve(PRACTICE_STATEMENTS_DIR, safeKey);
      if (!filePath.startsWith(PRACTICE_STATEMENTS_DIR + path.sep)) return null;
      const content = fs.readFileSync(filePath);
      if (!content.length) return null;
      const name = attachment.fileName || "statement.pdf";
      out.push({
        filename: name.endsWith(".pdf") ? name : `${name}.pdf`,
        content,
      });
    } catch {
      return null;
    }
  }
  return out.length ? out : null;
}

/**
 * Retries a practice bundle exactly as it was issued: the stored doctor PDFs
 * go to the addresses the sender chose. Recomputing a consolidated statement
 * here (what the legacy path does) would re-include doctors the sender
 * excluded, change the invoice scope, and reload saved contacts — including
 * addresses that were deliberately removed for that send.
 */
async function attemptBundleSendForRun(
  run: typeof statementSendRuns.$inferSelect,
  context: StatementSendRunBundleContext,
  /**
   * Replacement recipient list for this attempt, e.g. an address the user
   * added after the first attempt was skipped for having none. It is used for
   * this send and kept on the run so a later attempt does not fall back to
   * the list that already failed. Saved contacts are still never reloaded.
   */
  recipientOverride?: string[] | null
): Promise<RetryResult> {
  const labOrg = await db.query.organizations.findFirst({
    where: eq(organizations.id, run.labOrganizationId),
  });
  const labName = labOrg?.displayName || labOrg?.name || "LabTrax";
  const placements = resolveLocalLogoplacements(labOrg);
  const emailLogoUrl =
    placements.has("emails") && labOrg?.logoUrl
      ? `${getAppBaseUrl()}${labOrg.logoUrl}`
      : null;

  let practiceName = run.practiceName;
  let practiceOptedOut = false;
  if (run.practiceOrganizationId) {
    const practice = await db.query.organizations.findFirst({
      where: eq(organizations.id, run.practiceOrganizationId),
    });
    if (practice) {
      practiceName = practice.displayName || practice.name || practiceName;
      practiceOptedOut = practice.statementEmailOptOut ?? false;
    }
  }

  const statement = context.statementId
    ? await db.query.practiceStatements.findFirst({
        where: eq(practiceStatements.id, context.statementId),
      })
    : null;
  const manifest = coerceStatementBundleManifest(
    (statement as any)?.bundleManifestJson
  );
  // The sender's own list wins. The manifest is only a fallback for rows
  // written before the context recorded recipients at all; saved contacts
  // are never reloaded. An explicit list — including an explicitly empty
  // one — is authoritative, exactly as on the original send: a send whose
  // addresses were all removed must not resurrect them here.
  const recipientsRecorded = Array.isArray(
    ((run as any).bundleContextJson as { recipients?: unknown } | null)
      ?.recipients
  );
  const recipients = normalizeEmailList(
    Array.isArray(recipientOverride)
      ? recipientOverride
      : recipientsRecorded
        ? context.recipients
        : (manifest?.recipients ?? [])
  );
  const contextChanged =
    recipients.join("|") !== normalizeEmailList(context.recipients).join("|");

  let status: RetryResult["status"] = "sent";
  let errorMessage: string | undefined;
  // A bundle whose issued PDFs are gone cannot be repaired by waiting, so it
  // leaves the automatic retry queue instead of failing on every tick.
  let retryable = true;

  try {
    const attachments = manifest ? loadIssuedBundleAttachments(manifest) : null;
    if (practiceOptedOut) {
      status = "skipped_opted_out";
      errorMessage = "Practice has opted out of statement emails";
    } else if (!recipients.length) {
      status = "skipped_no_email";
      errorMessage =
        "No recipient addresses were chosen for this statement. Re-send it from Generate Statements to choose recipients.";
    } else if (!attachments) {
      status = "failed";
      retryable = false;
      errorMessage =
        "The statement PDFs issued with this send are no longer available. Re-send this practice from Generate Statements.";
    } else {
      // The message is reproduced from the original send, not recomposed.
      const result = await sendStatementEmail({
        to: recipients[0]!,
        cc: recipients.slice(1),
        fromName: labName,
        practiceName,
        recipientType: "practice",
        periodLabel: context.periodLabel || periodLabel(run.periodMonth),
        attachments,
        totals: {
          billed: Number(run.totalBilled ?? 0),
          open: Number(run.openBalance ?? 0),
        },
        template: {
          subject: context.emailSubject,
          body: context.emailBody,
          header: context.emailHeader,
          replyTo: context.emailReplyTo,
        },
        labLogoUrl: emailLogoUrl,
      });
      if (!result.delivered) {
        status = "failed";
        errorMessage = result.reason || "Email send failed";
      } else if (statement) {
        // Record the delivery against the issued statement so its history
        // shows the retry, the same way the original send did.
        for (const recipient of recipients) {
          await db
            .insert(practiceStatementSends)
            .values({
              statementId: statement.id,
              channel: "email",
              recipient,
              status: "sent",
            })
            .catch(() => {
              /* history is best effort; the email already went out */
            });
        }
      }
    }
  } catch (err: unknown) {
    status = "failed";
    errorMessage = err instanceof Error ? err.message : String(err);
    logger.error(
      { err, runId: run.id, practiceId: run.practiceOrganizationId },
      "Statement bundle retry send failed"
    );
  }

  const now = new Date();
  const newAttempt = run.attemptCount + 1;
  const delay =
    status === "failed" && retryable && newAttempt < STATEMENT_MAX_ATTEMPTS
      ? nextAttemptDelayMs(newAttempt)
      : null;

  // The snapshot figures stay as issued — a bundle re-sends the PDFs it was
  // created with, so recomputing its totals would misreport what was mailed.
  await db
    .update(statementSendRuns)
    .set({
      status,
      errorMessage: errorMessage ?? null,
      practiceEmail: recipients[0] ?? run.practiceEmail,
      practiceName,
      attemptCount: newAttempt,
      lastAttemptAt: now,
      nextAttemptAt: delay !== null ? new Date(now.getTime() + delay) : null,
      // Keep a corrected recipient list on the run so the next attempt (and
      // Send history) uses it instead of the list that could not be mailed.
      ...(contextChanged
        ? {
            bundleContextJson: {
              ...context,
              recipients,
            } satisfies StatementSendRunBundleContext,
          }
        : {}),
    })
    .where(eq(statementSendRuns.id, run.id));

  // Deliberately no statementSchedules bump: a wizard bundle is a manual send
  // for a chosen scope, not the lab's monthly scheduled statement run.
  return { runId: run.id, status, attemptCount: newAttempt, errorMessage };
}

async function attemptStatementSendForRun(runId: string): Promise<RetryResult> {
  const run = await db.query.statementSendRuns.findFirst({
    where: eq(statementSendRuns.id, runId),
  });
  if (!run) {
    throw new Error(`statementSendRun ${runId} not found`);
  }
  if (run.status === "sent") {
    return {
      runId,
      status: "sent",
      attemptCount: run.attemptCount,
    };
  }

  // Practice bundles carry their own issued documents and recipient list.
  const bundleContext = coerceStatementSendRunBundleContext(
    (run as any).bundleContextJson
  );
  if (bundleContext) {
    return attemptBundleSendForRun(run, bundleContext);
  }

  const labOrg = await db.query.organizations.findFirst({
    where: eq(organizations.id, run.labOrganizationId),
  });
  const labName = labOrg?.displayName || labOrg?.name || "LabTrax";
  const retryPlacements = resolveLocalLogoplacements(labOrg);
  const retryLogoBuffer = retryPlacements.has("statements")
    ? await readLogoBuffer(run.labOrganizationId)
    : null;
  const retryEmailLogoUrl =
    retryPlacements.has("emails") && labOrg?.logoUrl
      ? `${getAppBaseUrl()}${labOrg.logoUrl}`
      : null;

  // Re-resolve the practice's billing email and opt-out flag — they may have
  // been corrected between the original failed attempt and the retry.
  let practiceEmail = run.practiceEmail;
  let practiceName = run.practiceName;
  let practiceOptedOut = false;
  if (run.practiceOrganizationId) {
    const practice = await db.query.organizations.findFirst({
      where: eq(organizations.id, run.practiceOrganizationId),
    });
    if (practice) {
      practiceEmail = practice.billingEmail || null;
      practiceName = practice.displayName || practice.name || practiceName;
      practiceOptedOut = practice.statementEmailOptOut ?? false;
    }
  }

  const retryScope =
    run.triggeredBy === "manual"
      ? coerceStatementSendRunRetryScopeContext(
          (run as any).retryScopeJson
        )
      : null;
  let data: PracticeStatementData | null;
  if (retryScope) {
    const scopedStatements = await buildPracticeStatementsForScope(
      run.labOrganizationId,
      {
        scope: retryScope.invoiceScope,
        recipientType: retryScope.recipientType,
        practiceIds:
          retryScope.recipientType === "practice" ? [retryScope.groupKey] : null,
        doctorKeys:
          retryScope.recipientType === "doctor" ? [retryScope.groupKey] : null,
        limitToPracticeOrgIds:
          retryScope.recipientType === "doctor" && run.practiceOrganizationId
            ? [run.practiceOrganizationId]
            : null,
        doctorFilters: retryScope.doctorFilters,
        from: retryScope.from ? new Date(retryScope.from) : null,
        to: retryScope.to ? new Date(retryScope.to) : null,
        asOf: retryScope.asOf ? new Date(retryScope.asOf) : null,
      }
    );
    data =
      scopedStatements.find(
        (statement) => statement.practiceId === retryScope.groupKey
      ) ?? null;
  } else {
    // Scheduled runs and legacy rows without a saved manual scope keep the
    // original calendar-month retry behavior.
    const [y, m] = run.periodMonth.split("-").map((s) => parseInt(s, 10));
    const periodStart = new Date(Date.UTC(y!, m! - 1, 1, 0, 0, 0));
    const periodEnd = new Date(Date.UTC(y!, m!, 1, 0, 0, 0));
    const allForLab = await buildPracticeStatements(
      run.labOrganizationId,
      periodStart,
      periodEnd
    );
    data =
      allForLab.find((p) => p.practiceId === run.practiceOrganizationId) || null;
  }

  let status: RetryResult["status"] = "sent";
  let errorMessage: string | undefined;

  try {
    if (practiceOptedOut) {
      status = "skipped_opted_out";
      errorMessage = "Practice has opted out of statement emails";
    } else if (!practiceEmail) {
      status = "skipped_no_email";
      errorMessage = "Practice has no billing email on file";
    } else if (!data) {
      // No invoices remain for the period (perhaps all voided/deleted).
      // Treat this as resolved so it stops being retried.
      status = "sent";
    } else {
      const safeName = practiceName.replace(/[^a-z0-9-_]+/gi, "_");
      const filename = `statement-${safeName}-${run.periodMonth}.pdf`;
      const retrySched = await db.query.statementSchedules.findFirst({
        where: eq(statementSchedules.labOrganizationId, run.labOrganizationId),
      });
      const pdfBuffer = await generateStatementPdfBuffer(
        labName,
        data,
        retryScope?.periodLabel || periodLabel(run.periodMonth),
        retryLogoBuffer,
        (labOrg as any)?.logoPdfSize,
        retryScope?.invoiceScope,
        labOrg?.invoiceDueDayOfMonth ?? null,
        retrySched?.emailReplyTo ?? null,
        coerceStatementTemplate((labOrg as any)?.statementTemplate).defaultTextBlocks,
        run.labOrganizationId,
        coerceStatementTemplate((labOrg as any)?.statementTemplate)
      );
      const retryCcList = run.practiceOrganizationId
        ? (await getBillingAdditionalEmailsMap([run.practiceOrganizationId])).get(
            run.practiceOrganizationId
          ) ?? null
        : null;
      const result = await sendStatementEmail({
        to: practiceEmail,
        cc: retryCcList,
        fromName: labName,
        practiceName,
        periodLabel: periodLabel(run.periodMonth),
        pdfBuffer,
        pdfFilename: filename,
        totals: { billed: data.totalBilled, open: data.openBalance },
        labLogoUrl: retryEmailLogoUrl,
      });
      if (!result.delivered) {
        status = "failed";
        errorMessage = result.reason || "Email send failed";
      }
    }
  } catch (err: unknown) {
    status = "failed";
    errorMessage = err instanceof Error ? err.message : String(err);
    logger.error(
      { err, runId, practiceId: run.practiceOrganizationId },
      "Statement retry send failed"
    );
  }

  const now = new Date();
  const newAttempt = run.attemptCount + 1;
  const delay =
    status === "failed" && newAttempt < STATEMENT_MAX_ATTEMPTS
      ? nextAttemptDelayMs(newAttempt)
      : null;

  // Refresh the snapshot fields from the freshly recomputed data so the
  // history row reflects current numbers after the retry.
  const refreshedTotals = data
    ? {
        invoiceCount: data.invoiceCount,
        totalBilled: data.totalBilled.toFixed(2),
        openBalance: data.openBalance.toFixed(2),
      }
    : {
        invoiceCount: run.invoiceCount,
        totalBilled: run.totalBilled,
        openBalance: run.openBalance,
      };

  await db
    .update(statementSendRuns)
    .set({
      status,
      errorMessage: errorMessage ?? null,
      practiceEmail,
      practiceName,
      attemptCount: newAttempt,
      lastAttemptAt: now,
      nextAttemptAt: delay !== null ? new Date(now.getTime() + delay) : null,
      invoiceCount: refreshedTotals.invoiceCount,
      totalBilled: refreshedTotals.totalBilled,
      openBalance: refreshedTotals.openBalance,
    })
    .where(eq(statementSendRuns.id, runId));

  // On success, bump the parent schedule's lastRunAt. Only advance
  // lastSentForMonth if this run's period is NOT older than what the
  // schedule already has — otherwise retrying a stale failed row could
  // rewind the marker and cause processDueSchedules to re-send a newer
  // month that's already complete.
  if (status === "sent") {
    await db
      .update(statementSchedules)
      .set({
        lastRunAt: now,
        lastSentForMonth: run.periodMonth,
      })
      .where(
        and(
          eq(statementSchedules.labOrganizationId, run.labOrganizationId),
          or(
            isNull(statementSchedules.lastSentForMonth),
            lte(statementSchedules.lastSentForMonth, run.periodMonth)
          )
        )
      )
      .catch(() => {
        /* schedule may not exist for manually-triggered labs */
      });
    // If the conditional update above didn't match (because the schedule
    // is already at a newer period), still bump lastRunAt without
    // touching lastSentForMonth.
    await db
      .update(statementSchedules)
      .set({ lastRunAt: now })
      .where(eq(statementSchedules.labOrganizationId, run.labOrganizationId))
      .catch(() => {
        /* best effort */
      });
  }

  return {
    runId,
    status,
    attemptCount: newAttempt,
    errorMessage,
  };
}

export async function retryStatementSendRun(
  runId: string
): Promise<RetryResult> {
  return attemptStatementSendForRun(runId);
}

/**
 * Re-sends a practice bundle exactly as it was issued, optionally to a
 * different recipient list. Returns null when the run is not a bundle or has
 * no issued documents — the caller then has to build the statement again,
 * because there is nothing to replay.
 */
export async function replayIssuedBundleSend(args: {
  labOrganizationId: string;
  runId: string;
  recipientEmails?: string[] | null;
}): Promise<{
  result: RetryResult;
  practiceId: string | null;
  practiceName: string;
  statementId: string;
  recipients: string[];
  attachments: Array<{
    documentKey: string;
    label: string;
    fileName: string;
    invoiceCount: number;
  }>;
} | null> {
  const run = await db.query.statementSendRuns.findFirst({
    where: and(
      eq(statementSendRuns.id, args.runId),
      eq(statementSendRuns.labOrganizationId, args.labOrganizationId)
    ),
  });
  if (!run) return null;
  const context = coerceStatementSendRunBundleContext(
    (run as any).bundleContextJson
  );
  if (!context?.statementId) return null;

  const statement = await db.query.practiceStatements.findFirst({
    where: eq(practiceStatements.id, context.statementId),
  });
  const manifest = coerceStatementBundleManifest(
    (statement as any)?.bundleManifestJson
  );
  if (!manifest?.attachments.length) return null;

  const result = await attemptBundleSendForRun(
    run,
    context,
    args.recipientEmails ?? null
  );
  const recipients = normalizeEmailList(
    Array.isArray(args.recipientEmails)
      ? args.recipientEmails
      : context.recipients
  );
  return {
    result,
    practiceId: run.practiceOrganizationId,
    practiceName: run.practiceName,
    statementId: context.statementId,
    recipients,
    attachments: manifest.attachments.map((attachment) => ({
      documentKey: attachment.documentKey,
      label: attachment.label,
      fileName: attachment.fileName,
      invoiceCount: attachment.invoiceCount,
    })),
  };
}

// ── On-demand batch-send helpers ─────────────────────────────────────────────

export type InvoiceScope =
  | "open"
  | "open_overdue_90"
  | "all"
  | "last_30_days"
  | "over_90_days"
  | "custom"
  | "open_as_of";

/** Sentinel group key/label for doctor-mode invoices with no resolvable doctor. */
export const NO_DOCTOR_KEY = "__no_doctor__";
export const NO_DOCTOR_LABEL = "Unassigned / No doctor";
/** Sentinel org-key part for doctor-mode invoices with no provider org. */
export const NO_ORG_KEY = "__no_org__";

export interface BuildScopeOptions {
  scope: InvoiceScope;
  /** "practice" (group by provider org) or "doctor" (group by case doctor). */
  recipientType?: "practice" | "doctor";
  /** Practice-mode selection filter (provider org ids). */
  practiceIds?: string[] | null;
  /** Doctor-mode selection filter (doctor group keys). */
  doctorKeys?: string[] | null;
  /** Doctor-mode practice-org pre-filter: when non-empty, only invoices from
   *  these provider orgs are included in the doctor grouping. Used to scope
   *  the recipients list to the practices selected on the Statements table. */
  limitToPracticeOrgIds?: string[] | null;
  /** Custom-scope inclusive issue-date bounds. */
  from?: Date | null;
  to?: Date | null;
  /** "open_as_of" cutoff: all open invoices issued on or before this date. */
  asOf?: Date | null;
  /**
   * Optional half-open createdAt period. Monthly automatic statements use this
   * to retain their existing calendar-period scope while sharing the wizard's
   * practice-bundle builder.
   */
  createdAtRange?: { start: Date; endExclusive: Date } | null;
  /**
   * Practice-mode per-practice doctor filter. Keys are practice org IDs;
   * values are arrays of allowed doctor names. When set, only invoices whose
   * linked case doctor appears in the list are included in that practice's
   * statement. Practices absent from the map receive all their doctors.
   */
  doctorFilters?: Record<string, string[]> | null;
}

/**
 * Builds statement data grouped by practice or doctor, scoped by invoice
 * status / age / date range (not calendar period). Used by the on-demand
 * batch-send + download modal.
 *
 * Scopes:
 * - "open" / "open_overdue_90": all open invoices (non-paid, non-voided);
 *   groups with zero open balance are excluded. ("open_overdue_90" is the
 *   same data — the PDF highlights 90+ day aging.)
 * - "over_90_days": open invoices aged >90 days by DUE date; groups with
 *   zero open balance are excluded.
 * - "last_30_days": every invoice issued in the last 30 days, any status.
 * - "custom": every invoice issued within [from, to], any status.
 * - "all": every invoice regardless of status.
 *
 * Grouping never depends on parentLabOrganizationId — a practice with
 * invoices but no parent-lab link is still returned.
 */
export async function buildPracticeStatementsForScope(
  labOrganizationId: string,
  opts: BuildScopeOptions
): Promise<PracticeStatementData[]> {
  const {
    scope,
    recipientType = "practice",
    practiceIds,
    doctorKeys,
    doctorFilters,
    limitToPracticeOrgIds,
    from,
    to,
    asOf,
  } = opts;

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

  const whereClauses = [eq(invoices.labOrganizationId, labOrganizationId), finalizedInvoiceSql()];
  switch (scope) {
    case "open":
    case "open_overdue_90":
      whereClauses.push(
        ne(invoices.status, "paid"),
        ne(invoices.status, "void")
      );
      break;
    case "over_90_days":
      whereClauses.push(
        ne(invoices.status, "paid"),
        ne(invoices.status, "void"),
        lt(invoices.dueAt, ninetyDaysAgo)
      );
      break;
    case "last_30_days":
      whereClauses.push(gte(invoices.issuedAt, thirtyDaysAgo));
      break;
    case "custom":
      if (from) whereClauses.push(gte(invoices.issuedAt, from));
      if (to) whereClauses.push(lte(invoices.issuedAt, to));
      break;
    case "open_as_of":
      whereClauses.push(
        ne(invoices.status, "paid"),
        ne(invoices.status, "void")
      );
      if (asOf) whereClauses.push(lte(invoices.issuedAt, asOf));
      break;
    case "all":
    default:
      break;
  }
  if (opts.createdAtRange) {
    whereClauses.push(
      gte(invoices.createdAt, opts.createdAtRange.start),
      lt(invoices.createdAt, opts.createdAtRange.endExclusive)
    );
  }

  const rows = await db.query.invoices.findMany({
    where: and(...whereClauses),
    orderBy: [asc(invoices.createdAt)],
  });
  if (!rows.length) return [];

  // Resolve the doctor for each invoice via its linked case. In doctor mode
  // this drives grouping; in practice mode it powers sub-row data and the
  // per-practice doctor filter (doctorFilters).
  const doctorByCaseId = new Map<string, string>();
  const allCaseIds = Array.from(
    new Set(rows.map((r) => r.caseId).filter((id): id is string => !!id))
  );
  if (allCaseIds.length) {
    const caseRows = await db
      .select({ id: cases.id, doctorName: cases.doctorName })
      .from(cases)
      .where(inArray(cases.id, allCaseIds));
    for (const c of caseRows) {
      const name = c.doctorName?.trim();
      if (name) doctorByCaseId.set(c.id, name);
    }
  }

  // Hydrate every provider org referenced so we can attach contact info.
  const orgIdsNeeded = Array.from(
    new Set(
      rows
        .map((r) => r.providerOrganizationId)
        .filter((id): id is string => id !== null)
    )
  );
  const orgRows = orgIdsNeeded.length
    ? await db
        .select()
        .from(organizations)
        .where(inArray(organizations.id, orgIdsNeeded))
    : [];
  const orgById = new Map(orgRows.map((o) => [o.id, o]));

  const practiceFilter =
    recipientType === "practice" && practiceIds && practiceIds.length
      ? new Set(practiceIds)
      : null;
  const doctorFilter =
    recipientType === "doctor" && doctorKeys && doctorKeys.length
      ? new Set(doctorKeys)
      : null;
  const doctorPracticeOrgFilter =
    recipientType === "doctor" && limitToPracticeOrgIds && limitToPracticeOrgIds.length
      ? new Set(limitToPracticeOrgIds)
      : null;

  const grouped = new Map<string, PracticeStatementData>();
  const invoiceIdMap = new Map<string, { practiceId: string; index: number }>();
  // Tracks per-doctor sub-totals for each practice group (practice mode
  // only). The NO_DOCTOR_KEY entry collects invoices with no resolvable
  // doctor so they stay explicitly selectable instead of vanishing.
  const practiceDocsByKey = new Map<
    string,
    Map<string, { invoiceCount: number; totalBilled: number; openBalance: number }>
  >();

  for (const inv of rows) {
    const orgId = inv.providerOrganizationId;
    const invoiceDoctorName =
      (inv.caseId && doctorByCaseId.get(inv.caseId)) || null;
    let groupKey: string;
    let displayName: string;
    if (recipientType === "doctor") {
      const doctor = invoiceDoctorName;
      const docPart = doctor ?? NO_DOCTOR_KEY;
      // Scope each doctor recipient to a SINGLE provider org. Grouping by
      // doctor name alone merges invoices across practices and then delivers
      // one combined PDF to whichever practice contact was resolved first —
      // leaking one practice's financials to another. The composite
      // "<orgId>::<doctor>" key keeps every recipient bound to exactly one
      // practice (and therefore one unambiguous email/phone contact).
      const orgPart = orgId ?? NO_ORG_KEY;
      groupKey = `${orgPart}::${docPart}`;
      displayName = doctor ?? NO_DOCTOR_LABEL;
      // Skip invoices whose provider org is not in the pre-filter set. This
      // lets the recipients endpoint return only doctors from the practices
      // that were selected on the Statements table.
      if (doctorPracticeOrgFilter && !doctorPracticeOrgFilter.has(orgPart)) continue;
      if (doctorFilter && !doctorFilter.has(groupKey)) continue;
    } else {
      // Legacy mobile invoices have no provider org — skip in practice grouping.
      if (!orgId) continue;
      if (practiceFilter && !practiceFilter.has(orgId)) continue;
      // Per-practice doctor filter: skip invoices whose doctor isn't allowed.
      // Invoices with no resolvable doctor are kept only when the caller
      // explicitly lists the NO_DOCTOR_KEY sentinel, so a partial doctor
      // selection can still include (or exclude) the unassigned bucket.
      if (doctorFilters && doctorFilters[orgId]) {
        const allowedDoctors = doctorFilters[orgId]!;
        if (!invoiceDoctorName) {
          if (!allowedDoctors.includes(NO_DOCTOR_KEY)) continue;
        } else if (!allowedDoctors.includes(invoiceDoctorName)) {
          continue;
        }
      }
      groupKey = orgId;
      const org = orgById.get(orgId);
      displayName = org?.displayName || org?.name || "Unknown practice";
    }

    const org = orgId ? orgById.get(orgId) : undefined;
    const cur =
      grouped.get(groupKey) ??
      ({
        practiceId: groupKey,
        practiceName: displayName,
        practiceEmail: org?.billingEmail || null,
        statementEmailOptOut: org?.statementEmailOptOut ?? false,
        providerOrganizationId:
          recipientType === "practice" ? orgId ?? null : org?.id ?? null,
        phone: org?.phone || null,
        recipientType,
        invoiceCount: 0,
        totalBilled: 0,
        totalPaid: 0,
        openBalance: 0,
        invoices: [],
      } as PracticeStatementData);

    // Doctor groups have no contact record of their own — backfill from the
    // first invoice in the group that carries a provider org.
    if (recipientType === "doctor" && !cur.providerOrganizationId && org) {
      cur.providerOrganizationId = org.id;
      cur.practiceEmail = org.billingEmail || null;
      cur.phone = org.phone || null;
      cur.statementEmailOptOut = org.statementEmailOptOut ?? false;
    }

    const total = Number(inv.total ?? 0);
    const balance = Number(inv.balanceDue ?? 0);
    cur.invoiceCount += 1;
    cur.totalBilled += total;
    cur.totalPaid += Math.max(0, total - balance);
    if (inv.status !== "void") cur.openBalance += balance;
    const meta = (inv.displayMetadataJson ?? null) as
      | { patientName?: string | null; billTo?: string | null }
      | null;
    invoiceIdMap.set(inv.id, { practiceId: groupKey, index: cur.invoices.length });
    cur.invoices.push({
      id: inv.id,
      invoiceNumber: inv.invoiceNumber,
      issuedAt: inv.issuedAt ?? inv.createdAt ?? null,
      dueAt: inv.dueAt ?? null,
      status: inv.status,
      total: String(inv.total ?? "0"),
      balanceDue: String(inv.balanceDue ?? "0"),
      patientName: meta?.patientName ?? null,
      billTo: meta?.billTo ?? null,
      doctorName: invoiceDoctorName,
    });
    grouped.set(groupKey, cur);

    // Track per-doctor sub-totals per practice group for sub-row data and
    // for the per-doctor statement documents built from this scope.
    if (recipientType === "practice") {
      const docKey = invoiceDoctorName ?? NO_DOCTOR_KEY;
      let stats = practiceDocsByKey.get(groupKey);
      if (!stats) {
        stats = new Map();
        practiceDocsByKey.set(groupKey, stats);
      }
      const entry =
        stats.get(docKey) ?? { invoiceCount: 0, totalBilled: 0, openBalance: 0 };
      entry.invoiceCount += 1;
      entry.totalBilled += total;
      if (inv.status !== "void") entry.openBalance += balance;
      stats.set(docKey, entry);
    }
  }

  await attachLineItems(grouped, invoiceIdMap);
  await attachPayments(grouped, invoiceIdMap);

  // Attach sorted doctor lists to each practice group. The unassigned bucket
  // (when present) is always listed last so it reads as an exception.
  if (recipientType === "practice") {
    for (const [key, data] of grouped) {
      const stats = practiceDocsByKey.get(key);
      if (!stats) {
        data.doctors = [];
        continue;
      }
      const named = Array.from(stats.entries())
        .filter(([name]) => name !== NO_DOCTOR_KEY)
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      const unassigned = stats.get(NO_DOCTOR_KEY);
      data.doctors = [
        ...named.map(([name, s]) => ({
          key: name,
          name,
          email: null,
          phone: null,
          invoiceCount: s.invoiceCount,
          totalBilled: s.totalBilled,
          openBalance: s.openBalance,
        })),
        ...(unassigned
          ? [{
              key: NO_DOCTOR_KEY,
              name: NO_DOCTOR_LABEL,
              email: null,
              phone: null,
              invoiceCount: unassigned.invoiceCount,
              totalBilled: unassigned.totalBilled,
              openBalance: unassigned.openBalance,
            }]
          : []),
      ];
    }
  }

  const all = Array.from(grouped.values());
  await attachStatementContacts(labOrganizationId, all);
  const balanceScoped =
    scope === "open" || scope === "open_overdue_90" || scope === "over_90_days";
  return balanceScoped ? all.filter((s) => s.openBalance > 0) : all;
}

/**
 * One rendered statement document inside a practice bundle. Each document
 * covers exactly one doctor's invoices at that practice (or the practice's
 * unassigned invoices), and renders through the same server-authoritative
 * template used for doctor-recipient statements.
 */
export interface PracticeStatementDocument {
  /** Doctor name, or NO_DOCTOR_KEY for the practice's unassigned invoices. */
  documentKey: string;
  /** Resolved doctor name, or null for the unassigned document. */
  doctorName: string | null;
  /** Human-readable label used on the PDF and in the attachment name. */
  label: string;
  invoiceCount: number;
  totalBilled: number;
  totalPaid: number;
  openBalance: number;
  /** Statement payload rendered into this document's PDF. */
  data: PracticeStatementData;
}

/**
 * One outgoing practice message: a single billing practice, the documents
 * that must be attached to it, and the practice-level aggregate used for
 * the email body placeholders and the issued statement snapshot.
 */
export interface PracticeStatementBundle {
  /** Provider organization id — the billed practice identity. */
  practiceId: string;
  practiceName: string;
  /** Saved primary billing email, or null when none is on file. */
  practiceEmail: string | null;
  statementEmailOptOut: boolean;
  providerOrganizationId: string | null;
  phone: string | null;
  invoiceCount: number;
  totalBilled: number;
  totalPaid: number;
  openBalance: number;
  /** Practice-level aggregate restricted to the invoices actually attached. */
  practice: PracticeStatementData;
  documents: PracticeStatementDocument[];
}

/**
 * Builds one bundle per billed practice, partitioning that practice's scoped
 * invoices into a separate statement document per doctor.
 *
 * Grouping is keyed on the billed practice identity (providerOrganizationId)
 * and the case doctor recorded on each invoice — never on addresses, email
 * addresses, or doctor names shared across practices. Two locations of the
 * same billing practice are one bundle; two distinct practices that share an
 * address or email stay separate bundles.
 *
 * A doctor with no qualifying invoices produces no document. Qualifying
 * invoices with no resolvable doctor become one clearly labeled unassigned
 * document instead of disappearing.
 */
export async function buildPracticeStatementBundles(
  labOrganizationId: string,
  opts: Omit<BuildScopeOptions, "recipientType" | "doctorKeys" | "limitToPracticeOrgIds">
): Promise<PracticeStatementBundle[]> {
  const statements = await buildPracticeStatementsForScope(labOrganizationId, {
    ...opts,
    recipientType: "practice",
  });

  // Open scopes bill only what is actually outstanding, so a zero-balance
  // row never becomes its own attachment.
  const positiveBalanceOnly =
    opts.scope === "open" ||
    opts.scope === "open_overdue_90" ||
    opts.scope === "over_90_days";

  const bundles: PracticeStatementBundle[] = [];
  const documentData: PracticeStatementData[] = [];

  for (const practice of statements) {
    const byDoctor = new Map<string, PracticeStatementData["invoices"]>();
    for (const invoice of practice.invoices) {
      if (positiveBalanceOnly && Number(invoice.balanceDue ?? 0) <= 0) continue;
      const key = invoice.doctorName?.trim() || NO_DOCTOR_KEY;
      const list = byDoctor.get(key) ?? [];
      list.push(invoice);
      byDoctor.set(key, list);
    }

    const orderedKeys = [
      ...Array.from(byDoctor.keys())
        .filter((key) => key !== NO_DOCTOR_KEY)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      ...(byDoctor.has(NO_DOCTOR_KEY) ? [NO_DOCTOR_KEY] : []),
    ];

    const documents: PracticeStatementDocument[] = [];
    for (const documentKey of orderedKeys) {
      const docInvoices = byDoctor.get(documentKey) ?? [];
      if (!docInvoices.length) continue;
      const doctorName = documentKey === NO_DOCTOR_KEY ? null : documentKey;
      const label = doctorName ?? NO_DOCTOR_LABEL;
      const invoiceIds = new Set(docInvoices.map((invoice) => invoice.id));
      const totalBilled = docInvoices.reduce(
        (sum, invoice) => sum + Number(invoice.total ?? 0),
        0
      );
      const openBalance = docInvoices.reduce(
        (sum, invoice) =>
          invoice.status === "void"
            ? sum
            : sum + Number(invoice.balanceDue ?? 0),
        0
      );
      const totalPaid = docInvoices.reduce(
        (sum, invoice) =>
          sum +
          Math.max(
            0,
            Number(invoice.total ?? 0) - Number(invoice.balanceDue ?? 0)
          ),
        0
      );
      const payments = (practice.payments ?? []).filter((payment) =>
        invoiceIds.has(payment.invoiceId)
      );
      const latestPayment = payments.reduce<StatementPayment | null>(
        (latest, payment) =>
          !latest ||
          (payment.paidAt?.getTime() ?? 0) > (latest.paidAt?.getTime() ?? 0)
            ? payment
            : latest,
        null
      );
      const data: PracticeStatementData = {
        ...practice,
        // Mirror the doctor-recipient key shape so the document identifies
        // exactly one doctor at exactly one practice.
        practiceId: `${practice.providerOrganizationId ?? NO_ORG_KEY}::${documentKey}`,
        practiceName: label,
        recipientType: "doctor",
        doctorContact: null,
        doctors: [],
        invoiceCount: docInvoices.length,
        totalBilled,
        totalPaid,
        openBalance,
        invoices: docInvoices,
        payments,
        paidAt: latestPayment?.paidAt ?? null,
        paymentMethod: latestPayment?.paymentMethod ?? null,
      };
      documents.push({
        documentKey,
        doctorName,
        label,
        invoiceCount: docInvoices.length,
        totalBilled,
        totalPaid,
        openBalance,
        data,
      });
      documentData.push(data);
    }

    if (!documents.length) continue;

    const bundleInvoices = documents.flatMap((doc) => doc.data.invoices);
    const bundlePractice: PracticeStatementData = {
      ...practice,
      invoices: bundleInvoices,
      invoiceCount: bundleInvoices.length,
      totalBilled: documents.reduce((sum, doc) => sum + doc.totalBilled, 0),
      totalPaid: documents.reduce((sum, doc) => sum + doc.totalPaid, 0),
      openBalance: documents.reduce((sum, doc) => sum + doc.openBalance, 0),
    };

    bundles.push({
      practiceId: practice.practiceId,
      practiceName: practice.practiceName,
      practiceEmail: practice.practiceEmail,
      statementEmailOptOut: practice.statementEmailOptOut,
      providerOrganizationId: practice.providerOrganizationId ?? null,
      phone: practice.phone ?? null,
      invoiceCount: bundlePractice.invoiceCount,
      totalBilled: bundlePractice.totalBilled,
      totalPaid: bundlePractice.totalPaid,
      openBalance: bundlePractice.openBalance,
      practice: bundlePractice,
      documents,
    });
  }

  // Resolve the doctor/practice identity blocks each document PDF prints,
  // using the same contact resolution doctor-recipient statements use.
  await attachStatementContacts(labOrganizationId, documentData);

  return bundles;
}

/** How long an SMS statement link stays valid. */
export const STATEMENT_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Mints a single-recipient, time-limited capability token backing a secure
 * SMS statement link. No PHI or balances are stored inline in the SMS — the
 * PDF is regenerated on demand only for the holder of this token.
 */
export async function createStatementLinkToken(opts: {
  labOrganizationId: string;
  recipientType: "practice" | "doctor";
  recipientKey: string;
  practiceOrganizationId: string | null;
  practiceName: string;
  invoiceScope: InvoiceScope;
  from?: Date | null;
  to?: Date | null;
  periodLabel?: string | null;
}): Promise<{ token: string; url: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + STATEMENT_LINK_TTL_MS);
  await db.insert(statementLinkTokens).values({
    token,
    labOrganizationId: opts.labOrganizationId,
    recipientType: opts.recipientType,
    recipientKey: opts.recipientKey,
    practiceOrganizationId: opts.practiceOrganizationId,
    practiceName: opts.practiceName,
    invoiceScope: opts.invoiceScope,
    customFrom: opts.from ?? null,
    customTo: opts.to ?? null,
    periodLabel: opts.periodLabel ?? null,
    expiresAt,
  });
  const url = `${getAppBaseUrl()}/api/statement-links/${token}`;
  return { token, url, expiresAt };
}

/**
 * Validates a statement link token and regenerates that single recipient's
 * statement PDF. Returns null when the token is unknown or expired. Used by
 * the public (unauthenticated) SMS-link serving route — authorization is the
 * possession of the unguessable token, scoped to exactly one recipient.
 */
export async function getStatementLinkPdf(
  token: string
): Promise<{ pdfBuffer: Buffer; filename: string } | null> {
  const row = await db.query.statementLinkTokens.findFirst({
    where: eq(statementLinkTokens.token, token),
  });
  if (!row) return null;
  if (row.expiresAt.getTime() < Date.now()) return null;

  const scope = row.invoiceScope as InvoiceScope;
  const recipientType = (row.recipientType as "practice" | "doctor") ?? "practice";
  const statements = await buildPracticeStatementsForScope(row.labOrganizationId, {
    scope,
    recipientType,
    practiceIds: recipientType === "practice" ? [row.recipientKey] : null,
    doctorKeys: recipientType === "doctor" ? [row.recipientKey] : null,
    from: row.customFrom ?? null,
    to: row.customTo ?? null,
  });
  const match = statements.find((s) => s.practiceId === row.recipientKey);
  if (!match) return null;

  const [labOrg, linkSched] = await Promise.all([
    db.query.organizations.findFirst({
      where: eq(organizations.id, row.labOrganizationId),
    }),
    db.query.statementSchedules.findFirst({
      where: eq(statementSchedules.labOrganizationId, row.labOrganizationId),
    }),
  ]);
  const labName = labOrg?.displayName || labOrg?.name || "LabTrax";
  const effectivePlacements = resolveLocalLogoplacements(labOrg);
  const logoBuffer = effectivePlacements.has("statements")
    ? await readLogoBuffer(row.labOrganizationId)
    : null;
  const label =
    row.periodLabel?.trim() || defaultStatementPeriodLabel();
  const pdfBuffer = await generateStatementPdfBuffer(
    labName,
    match,
    label,
    logoBuffer,
    (labOrg as any)?.logoPdfSize,
    scope,
    labOrg?.invoiceDueDayOfMonth ?? null,
    linkSched?.emailReplyTo ?? null,
    coerceStatementTemplate((labOrg as any)?.statementTemplate).defaultTextBlocks,
    row.labOrganizationId,
    coerceStatementTemplate((labOrg as any)?.statementTemplate)
  );
  const safeName = match.practiceName.replace(/[^a-z0-9-_]+/gi, "_");
  return { pdfBuffer, filename: `statement-${safeName}.pdf` };
}

/**
 * Sends a secure SMS statement link to a phone number. The message contains
 * only a lab name and a time-limited link — never a balance or patient data.
 * Never throws — returns a result object instead.
 */
export async function sendStatementSms(opts: {
  to: string;
  labName: string;
  practiceName: string;
  periodLabel: string;
  link: string;
}): Promise<{ delivered: boolean; reason?: string }> {
  const { sendSms } = await import("./sms.js");
  const body =
    `${opts.labName}: Your statement for ${opts.practiceName} (${opts.periodLabel}) is ready. ` +
    `View it securely here: ${opts.link} (link expires in 7 days).`;
  const toE164 = normalizePhoneE164(opts.to);
  if (!toE164) {
    return { delivered: false, reason: `Invalid phone number: ${opts.to}` };
  }
  const result = await sendSms({ to: toE164, body });
  if (!result.ok && !result.skipped) {
    return { delivered: false, reason: result.errorMessage ?? "SMS send failed" };
  }
  return { delivered: true };
}

/**
 * Generates a ZIP archive from explicitly named statement documents. Used by
 * the practice-bundle download so the ZIP contains exactly the per-doctor
 * PDFs the matching email would attach.
 */
export async function generateStatementsZipBufferFromEntries(
  labName: string,
  entries: Array<{ name: string; data: PracticeStatementData }>,
  label: string,
  logoBuffer: Buffer | null,
  logoPdfSize?: string | null,
  invoiceScope?: InvoiceScope,
  invoiceDueDayOfMonth?: number | null,
  footerReplyTo?: string | null,
  footerTextBlocks?: StatementDefaultTextBlock[] | null,
  labOrganizationId?: string | null,
  savedTemplate?: ReturnType<typeof coerceStatementTemplate> | null
): Promise<Buffer> {
  const pdfs: Array<{ name: string; buf: Buffer }> = [];
  for (const entry of entries) {
    const buf = await generateStatementPdfBuffer(
      labName, entry.data, label, logoBuffer, logoPdfSize, invoiceScope,
      invoiceDueDayOfMonth, footerReplyTo, footerTextBlocks,
      labOrganizationId, savedTemplate
    );
    pdfs.push({ name: entry.name, buf });
  }

  return new Promise<Buffer>((resolve, reject) => {
    const arc = archiver("zip", { zlib: { level: 6 } });
    const chunks: Buffer[] = [];
    arc.on("data", (c: Buffer) => chunks.push(c));
    arc.on("end", () => resolve(Buffer.concat(chunks)));
    arc.on("error", reject);
    for (const { name, buf } of pdfs) {
      arc.append(buf, { name });
    }
    arc.finalize();
  });
}

/**
 * Generates a ZIP archive containing one statement PDF per group.
 * All PDFs are generated sequentially before the ZIP is assembled.
 */
export async function generateStatementsZipBuffer(
  labName: string,
  statements: PracticeStatementData[],
  label: string,
  logoBuffer: Buffer | null,
  logoPdfSize?: string | null,
  invoiceScope?: InvoiceScope,
  invoiceDueDayOfMonth?: number | null,
  footerReplyTo?: string | null,
  footerTextBlocks?: StatementDefaultTextBlock[] | null,
  labOrganizationId?: string | null,
  savedTemplate?: ReturnType<typeof coerceStatementTemplate> | null
): Promise<Buffer> {
  return generateStatementsZipBufferFromEntries(
    labName,
    statements.map((s) => ({
      name: `statement-${s.practiceName.replace(/[^a-z0-9-_]+/gi, "_")}.pdf`,
      data: s,
    })),
    label, logoBuffer, logoPdfSize, invoiceScope, invoiceDueDayOfMonth,
    footerReplyTo, footerTextBlocks, labOrganizationId, savedTemplate
  );
}

/** Strips characters that are unsafe in an attachment or ZIP entry name. */
export function sanitizeStatementFileNamePart(value: string): string {
  return (value.replace(/[^a-z0-9-_]+/gi, "_").replace(/^_+|_+$/g, "") || "statement")
    .slice(0, 60);
}

/**
 * Builds collision-safe statement file names. Two doctors whose names
 * sanitize to the same string still get distinct attachments.
 */
export function createStatementFileNamer(): (base: string) => string {
  const used = new Set<string>();
  return (base: string) => {
    let name = `${base}.pdf`;
    let n = 2;
    while (used.has(name.toLowerCase())) {
      name = `${base}-${n}.pdf`;
      n += 1;
    }
    used.add(name.toLowerCase());
    return name;
  };
}

/** One attachment recorded on an issued practice-bundle statement. */
export interface StatementBundleAttachment {
  documentKey: string;
  doctorName: string | null;
  label: string;
  /** Name the recipient sees on the email attachment / ZIP entry. */
  fileName: string;
  /** Durable storage key under uploads/practice-statements. */
  storageKey: string;
  fileSize: number;
  invoiceCount: number;
  totalBilled: string;
  balanceDue: string;
  invoiceIds: string[];
}

/**
 * Durable manifest persisted alongside a bundled practice statement: the
 * individual doctor PDFs that were attached and the addresses the message
 * was actually delivered to.
 */
export interface StatementBundleManifest {
  version: 1;
  recipients: string[];
  attachments: StatementBundleAttachment[];
}

/**
 * Recorded on a practice bundle's send-run row so a later retry re-sends what
 * was issued: the statement holding the doctor PDFs and the addresses the
 * sender chose for that send.
 */
export interface StatementSendRunBundleContext {
  version: 1;
  /** practiceStatements row carrying the issued PDFs and their manifest. */
  statementId: string | null;
  /** Addresses the bundle was addressed to, after any per-send editing. */
  recipients: string[];
  /** Label the bundle was sent under, so a retry reads identically. */
  periodLabel: string;
  /** Documents the bundle carried — the selected doctors, nothing wider. */
  documentKeys: string[];
  /** Message the bundle was sent with, so a retry reads identically. */
  emailSubject: string | null;
  emailBody: string | null;
  emailHeader: string | null;
  emailReplyTo: string | null;
}

/**
 * Original manual invoice scope for retry paths that rebuild a PDF instead of
 * replaying an issued practice bundle.
 */
export interface StatementSendRunRetryScopeContext {
  version: 1;
  invoiceScope: InvoiceScope;
  recipientType: "practice" | "doctor";
  /** Practice id or the composite doctor-group key from the original send. */
  groupKey: string;
  from: string | null;
  to: string | null;
  asOf: string | null;
  periodLabel: string;
  doctorFilters: Record<string, string[]> | null;
}

/** Narrows an unknown jsonb column to a manual retry-scope context. */
export function coerceStatementSendRunRetryScopeContext(
  value: unknown
): StatementSendRunRetryScopeContext | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<StatementSendRunRetryScopeContext>;
  const scopes: InvoiceScope[] = [
    "open",
    "open_overdue_90",
    "all",
    "last_30_days",
    "over_90_days",
    "custom",
    "open_as_of",
  ];
  if (
    raw.version !== 1 ||
    !scopes.includes(raw.invoiceScope as InvoiceScope) ||
    (raw.recipientType !== "practice" && raw.recipientType !== "doctor") ||
    typeof raw.groupKey !== "string" ||
    !raw.groupKey
  ) {
    return null;
  }

  const coerceDate = (date: unknown): string | null | undefined => {
    if (date === null || date === undefined) return null;
    if (typeof date !== "string" || Number.isNaN(Date.parse(date))) {
      return undefined;
    }
    return new Date(date).toISOString();
  };
  const from = coerceDate(raw.from);
  const to = coerceDate(raw.to);
  const asOf = coerceDate(raw.asOf);
  if (from === undefined || to === undefined || asOf === undefined) return null;

  let doctorFilters: Record<string, string[]> | null = null;
  if (raw.doctorFilters && typeof raw.doctorFilters === "object") {
    doctorFilters = {};
    for (const [practiceId, doctors] of Object.entries(raw.doctorFilters)) {
      if (Array.isArray(doctors)) {
        doctorFilters[practiceId] = doctors.filter(
          (doctor): doctor is string => typeof doctor === "string"
        );
      }
    }
  }

  return {
    version: 1,
    invoiceScope: raw.invoiceScope as InvoiceScope,
    recipientType: raw.recipientType,
    groupKey: raw.groupKey,
    from,
    to,
    asOf,
    periodLabel: typeof raw.periodLabel === "string" ? raw.periodLabel : "",
    doctorFilters,
  };
}

/** Narrows an unknown jsonb column to a bundle send-run context. */
export function coerceStatementSendRunBundleContext(
  value: unknown
): StatementSendRunBundleContext | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<StatementSendRunBundleContext>;
  if (!Array.isArray(raw.recipients) && !Array.isArray(raw.documentKeys)) {
    return null;
  }
  return {
    version: 1,
    statementId: typeof raw.statementId === "string" ? raw.statementId : null,
    recipients: Array.isArray(raw.recipients)
      ? raw.recipients.filter((r): r is string => typeof r === "string")
      : [],
    periodLabel: typeof raw.periodLabel === "string" ? raw.periodLabel : "",
    documentKeys: Array.isArray(raw.documentKeys)
      ? raw.documentKeys.filter((k): k is string => typeof k === "string")
      : [],
    emailSubject: typeof raw.emailSubject === "string" ? raw.emailSubject : null,
    emailBody: typeof raw.emailBody === "string" ? raw.emailBody : null,
    emailHeader: typeof raw.emailHeader === "string" ? raw.emailHeader : null,
    emailReplyTo: typeof raw.emailReplyTo === "string" ? raw.emailReplyTo : null,
  };
}

/** Narrows an unknown jsonb column to a bundle manifest. */
export function coerceStatementBundleManifest(
  value: unknown
): StatementBundleManifest | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<StatementBundleManifest>;
  if (!Array.isArray(raw.attachments)) return null;
  return {
    version: 1,
    recipients: Array.isArray(raw.recipients)
      ? raw.recipients.filter((r): r is string => typeof r === "string")
      : [],
    attachments: raw.attachments.filter(
      (a): a is StatementBundleAttachment =>
        !!a && typeof a === "object" && typeof (a as any).storageKey === "string"
    ),
  };
}

/**
 * One outgoing message in a batch run. Practice mode produces one unit per
 * billed practice carrying a document per selected doctor; doctor mode
 * produces one unit per doctor carrying its single document.
 */
interface StatementSendUnit {
  practiceId: string;
  practiceName: string;
  practiceEmail: string | null;
  statementEmailOptOut: boolean;
  providerOrganizationId: string | null;
  phone: string | null;
  /** Aggregate used for email placeholders, SMS link, and the snapshot. */
  summary: PracticeStatementData;
  documents: Array<{
    documentKey: string;
    doctorName: string | null;
    label: string;
    data: PracticeStatementData;
  }>;
  /** True for practice bundles (one email, one PDF per doctor). */
  isBundle: boolean;
}

export interface BatchSendResult {
  practiceId: string;
  practiceName: string;
  emailStatus: "sent" | "failed" | "skipped" | null;
  emailError: string | null;
  smsStatus: "sent" | "failed" | "skipped" | null;
  smsError: string | null;
  /** Addresses the practice message was actually sent to. */
  recipients?: string[];
  /** The doctor statement PDFs attached to the practice message. */
  attachments?: Array<{
    documentKey: string;
    label: string;
    fileName: string;
    invoiceCount: number;
  }>;
  /** The send-run row recorded for this practice. */
  runId?: string;
  /** Issued statement holding the PDFs this practice was sent, when any. */
  statementId?: string | null;
  /**
   * True when a later attempt can re-send the documents this practice was
   * issued. A retry then mails exactly what was prepared here instead of
   * rebuilding from invoices that may have changed in the meantime.
   */
  replayable?: boolean;
}

/** A rendered doctor document, before it is stored or attached. */
interface RenderedStatementDocument {
  documentKey: string;
  doctorName: string | null;
  label: string;
  fileName: string;
  buffer: Buffer;
  data: PracticeStatementData;
}

/**
 * Writes every rendered PDF of a bundle to durable storage. Throws when any
 * one of them cannot be stored: a bundle that is not fully on disk cannot be
 * re-sent later, so it must not be mailed at all.
 */
async function persistBundleAttachmentsOrThrow(args: {
  providerOrganizationId: string;
  periodMonth: string;
  rendered: RenderedStatementDocument[];
}): Promise<StatementBundleAttachment[]> {
  const saved: StatementBundleAttachment[] = [];
  try {
    for (const item of args.rendered) {
      const stored = await persistStatementPdf({
        buffer: item.buffer,
        providerOrganizationId: args.providerOrganizationId,
        periodMonth: args.periodMonth,
      });
      saved.push({
        documentKey: item.documentKey,
        doctorName: item.doctorName,
        label: item.label,
        fileName: item.fileName,
        storageKey: stored.storageKey,
        fileSize: stored.size,
        invoiceCount: item.data.invoiceCount,
        totalBilled: item.data.totalBilled.toFixed(2),
        balanceDue: item.data.openBalance.toFixed(2),
        invoiceIds: item.data.invoices.map((i) => i.id),
      });
    }
  } catch (err: unknown) {
    throw new Error(
      `The statement PDFs for this practice could not be stored, so nothing was emailed: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  return saved;
}

/**
 * Records ONE statement row per practice (never one per attachment — that
 * would count the same practice liability repeatedly) with a durable manifest
 * of its doctor PDFs and the addresses it is being sent to. Throws when the
 * row cannot be written, so the caller can fail the practice before mailing
 * something no retry would be able to reproduce.
 */
async function issueStatementBundleRecordOrThrow(args: {
  labOrganizationId: string;
  providerOrganizationId: string;
  summary: PracticeStatementData;
  attachments: StatementBundleAttachment[];
  recipients: string[];
  periodMonth: string;
  from: Date | null;
  to: Date | null;
  asOf: Date | null;
  createdByUserId: string | null;
}): Promise<string> {
  // Derive a meaningful period from the statement month when explicit
  // from/to dates are not provided. Avoids epoch→now as a fallback.
  const monthStart = new Date(`${args.periodMonth}-01T00:00:00.000Z`);
  const monthEnd = new Date(
    Date.UTC(
      monthStart.getUTCFullYear(),
      monthStart.getUTCMonth() + 1,
      0,
      23,
      59,
      59,
      999
    )
  );
  const manifest: StatementBundleManifest = {
    version: 1,
    recipients: args.recipients,
    attachments: args.attachments,
  };
  const primaryPdf = args.attachments[0]!;
  const s = args.summary;
  let statementId: string | null = null;
  try {
    const [stmt] = await db
      .insert(practiceStatements)
      .values({
        labOrganizationId: args.labOrganizationId,
        providerOrganizationId: args.providerOrganizationId,
        periodStart: args.from ?? monthStart,
        periodEnd: args.to ?? args.asOf ?? monthEnd,
        invoiceCount: s.invoiceCount,
        totalBilled: s.totalBilled.toFixed(2),
        totalPaid: s.totalPaid.toFixed(2),
        balanceDue: s.openBalance.toFixed(2),
        invoiceIdsJson: s.invoices.map((i) => i.id),
        invoiceAmountsJson: Object.fromEntries(
          s.invoices.map((invoice) => [invoice.id, invoice.total])
        ),
        invoiceDetailsJson: statementInvoiceDetails(s.invoices),
        // Legacy single-PDF consumers keep reading these columns; the
        // manifest carries the full attachment list.
        pdfStorageKey: primaryPdf.storageKey,
        pdfFileName: primaryPdf.fileName,
        pdfFileSize: primaryPdf.fileSize,
        bundleManifestJson: manifest,
        createdByUserId: args.createdByUserId,
      })
      .returning();
    statementId = stmt?.id ?? null;
  } catch (err: unknown) {
    throw new Error(
      `This practice's statement could not be recorded, so nothing was emailed: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  if (!statementId) {
    throw new Error(
      "This practice's statement could not be recorded, so nothing was emailed."
    );
  }
  return statementId;
}

/**
 * On-demand batch send: emails and/or SMS for the selected practices and scope.
 * Records each attempt in statementSendRuns for history tracking.
 */
export async function runBatchSendStatements(opts: {
  labOrganizationId: string;
  triggeredByUserId: string;
  recipientType?: "practice" | "doctor";
  practiceIds?: string[] | null;
  doctorKeys?: string[] | null;
  doctorFilters?: Record<string, string[]> | null;
  invoiceScope: InvoiceScope;
  from?: Date | null;
  to?: Date | null;
  asOf?: Date | null;
  channels: Array<"email" | "sms">;
  emailSubject?: string | null;
  emailBody?: string | null;
  emailHeader?: string | null;
  emailReplyTo?: string | null;
  periodLabel?: string | null;
  /**
   * Per-send recipient override keyed by practice id. When a practice has an
   * entry here it is authoritative for this send: the saved billing contacts
   * and the automatic billing CC list are both ignored, so an address the
   * user removed cannot return. Never written back to saved contacts.
   */
  recipientEmails?: Record<string, string[]> | null;
  /**
   * Practice id → send-run id of a bundle to re-send as issued instead of
   * rebuilding. A retry then mails the PDFs that practice was already given,
   * so invoices paid or edited since the failed attempt cannot change what
   * the recipient receives. Runs with no issued documents fall through to a
   * normal rebuild.
   */
  replayRuns?: Record<string, string> | null;
}): Promise<{ periodLabel: string; results: BatchSendResult[] }> {
  const labOrg = await db.query.organizations.findFirst({
    where: eq(organizations.id, opts.labOrganizationId),
  });
  const labName = labOrg?.displayName || labOrg?.name || "LabTrax";
  const effectivePlacements = resolveLocalLogoplacements(labOrg);
  const logoBuffer = effectivePlacements.has("statements")
    ? await readLogoBuffer(opts.labOrganizationId)
    : null;
  const emailLogoUrl =
    effectivePlacements.has("emails") && labOrg?.logoUrl
      ? `${getAppBaseUrl()}${labOrg.logoUrl}`
      : null;

  const sched = await db.query.statementSchedules.findFirst({
    where: eq(statementSchedules.labOrganizationId, opts.labOrganizationId),
  });
  const recipientType = opts.recipientType ?? "practice";
  const template = {
    subject: opts.emailSubject?.trim() || sched?.emailSubject || null,
    body: opts.emailBody?.trim() || sched?.emailBody || null,
    header: opts.emailHeader?.trim() || null,
    replyTo: opts.emailReplyTo?.trim() || sched?.emailReplyTo || null,
  };

  const label =
    opts.periodLabel?.trim() || defaultStatementPeriodLabel();

  const sendEmail = opts.channels.includes("email");
  const sendSms = opts.channels.includes("sms");

  // Email outcome of each practice whose issued bundle was re-sent as-is.
  // Replay covers the email only — an SMS carries a link to the live
  // statement, not the issued PDFs, so it keeps going through the normal
  // path below and a failed SMS is retried on its own.
  const replayedEmail = new Map<
    string,
    {
      practiceName: string;
      emailStatus: BatchSendResult["emailStatus"];
      emailError: string | null;
      recipients: string[];
      attachments: NonNullable<BatchSendResult["attachments"]>;
      documentKeys: string[];
      statementId: string;
    }
  >();
  if (sendEmail) {
    for (const [practiceId, runId] of Object.entries(opts.replayRuns ?? {})) {
      const replay = await replayIssuedBundleSend({
        labOrganizationId: opts.labOrganizationId,
        runId,
        recipientEmails: opts.recipientEmails?.[practiceId] ?? null,
      });
      // A run with nothing issued (e.g. a practice skipped for having no
      // recipient) is left to the normal build path below.
      if (!replay) continue;
      replayedEmail.set(practiceId, {
        practiceName: replay.practiceName,
        emailStatus:
          replay.result.status === "sent"
            ? "sent"
            : replay.result.status === "failed"
              ? "failed"
              : "skipped",
        emailError: replay.result.errorMessage ?? null,
        recipients: replay.recipients,
        attachments: replay.attachments,
        documentKeys: replay.attachments.map(
          (attachment) => attachment.documentKey
        ),
        statementId: replay.statementId,
      });
    }
  }

  // Practice mode sends one message per billed practice carrying a separate
  // statement PDF per selected doctor. Doctor mode keeps its existing
  // one-statement-per-doctor delivery untouched.
  const units: StatementSendUnit[] = [];
  // A practice whose email was replayed is rebuilt only when an SMS still
  // has to go out: re-reading its invoices cannot change the documents it
  // was issued, and the email for it is already handled.
  const buildPracticeIds = opts.practiceIds
    ? opts.practiceIds.filter((id) => sendSms || !replayedEmail.has(id))
    : null;
  const skipBuild = Boolean(
    opts.practiceIds?.length && !buildPracticeIds?.length
  );
  if (recipientType === "practice") {
    const bundles = skipBuild
      ? []
      : await buildPracticeStatementBundles(opts.labOrganizationId, {
          scope: opts.invoiceScope,
          practiceIds: buildPracticeIds,
          doctorFilters: opts.doctorFilters ?? null,
          from: opts.from ?? null,
          to: opts.to ?? null,
          asOf: opts.asOf ?? null,
        });
    for (const bundle of bundles) {
      units.push({
        practiceId: bundle.practiceId,
        practiceName: bundle.practiceName,
        practiceEmail: bundle.practiceEmail,
        statementEmailOptOut: bundle.statementEmailOptOut,
        providerOrganizationId: bundle.providerOrganizationId,
        phone: bundle.phone,
        summary: bundle.practice,
        documents: bundle.documents.map((doc) => ({
          documentKey: doc.documentKey,
          doctorName: doc.doctorName,
          label: doc.label,
          data: doc.data,
        })),
        isBundle: true,
      });
    }
  } else {
    const statements = await buildPracticeStatementsForScope(
      opts.labOrganizationId,
      {
        scope: opts.invoiceScope,
        recipientType,
        practiceIds: opts.practiceIds ?? null,
        doctorKeys: opts.doctorKeys ?? null,
        doctorFilters: opts.doctorFilters ?? null,
        from: opts.from ?? null,
        to: opts.to ?? null,
        asOf: opts.asOf ?? null,
      }
    );
    for (const s of statements) {
      units.push({
        practiceId: s.practiceId,
        practiceName: s.practiceName,
        practiceEmail: s.practiceEmail,
        statementEmailOptOut: s.statementEmailOptOut,
        providerOrganizationId: s.providerOrganizationId ?? null,
        phone: s.phone ?? null,
        summary: s,
        documents: [
          {
            documentKey: s.practiceId,
            doctorName: s.practiceName,
            label: s.practiceName,
            data: s,
          },
        ],
        isBundle: false,
      });
    }
  }

  // With no SMS to send, a replayed practice has nothing left to do here.
  if (replayedEmail.size && !sendSms) {
    for (let i = units.length - 1; i >= 0; i -= 1) {
      if (replayedEmail.has(units[i]!.practiceId)) units.splice(i, 1);
    }
  }

  // Saved billing recipients (primary + billing-tagged additional) for every
  // resolved provider org. A per-send override replaces this list entirely.
  const savedRecipientsMap = await getPracticeBillingRecipientsMap(
    [
      ...new Map(
        units
          .filter((unit) => !!unit.providerOrganizationId)
          .map((unit) => [
            unit.providerOrganizationId!,
            { id: unit.providerOrganizationId!, billingEmail: unit.practiceEmail },
          ])
      ).values(),
    ]
  );

  const periodMonthStr = new Date().toISOString().slice(0, 7);
  const results: BatchSendResult[] = [];
  const statementTemplate = coerceStatementTemplate(
    (labOrg as any)?.statementTemplate
  );

  for (const unit of units) {
    const s = unit.summary;
    const safeName = sanitizeStatementFileNamePart(unit.practiceName);

    const overrideRaw = opts.recipientEmails?.[unit.practiceId];
    const override = overrideRaw ? normalizeEmailList(overrideRaw) : null;
    const savedRecipients = unit.providerOrganizationId
      ? (savedRecipientsMap.get(unit.providerOrganizationId) ?? [])
      : normalizeEmailList([unit.practiceEmail]);
    const recipients = override ?? savedRecipients;
    // This practice's email was already re-sent from its issued documents;
    // the unit only exists so its SMS can still go out.
    const replayed = replayedEmail.get(unit.practiceId);
    const effectiveRecipients = replayed ? replayed.recipients : recipients;

    let emailStatus: BatchSendResult["emailStatus"] = null;
    let emailError: string | null = null;
    let smsStatus: BatchSendResult["smsStatus"] = null;
    let smsError: string | null = null;
    // Durable attachments and the statement row they were issued under, both
    // written before the send attempt so a retry can replay this exact send.
    let persistedAttachments: StatementBundleAttachment[] = [];
    let issuedStatementId: string | null = null;
    let sentAttachments: BatchSendResult["attachments"] = undefined;

    if (sendEmail) {
      if (replayed) {
        // Re-rendering and mailing here would deliver a second, different
        // message on top of the documents just re-sent.
        emailStatus = replayed.emailStatus;
        emailError = replayed.emailError;
        issuedStatementId = replayed.statementId;
        sentAttachments = replayed.attachments;
      } else if (unit.statementEmailOptOut) {
        emailStatus = "skipped";
        emailError = "Practice opted out of statement emails";
      } else if (!recipients.length) {
        emailStatus = "skipped";
        emailError = override
          ? "No recipient addresses selected for this practice"
          : "No billing email on file";
      } else {
        try {
          // Render every attachment first. The message goes out only once
          // all of its PDFs exist — never as a partial bundle.
          const nextFileName = createStatementFileNamer();
          const rendered: Array<{
            documentKey: string;
            doctorName: string | null;
            label: string;
            fileName: string;
            buffer: Buffer;
            data: PracticeStatementData;
          }> = [];
          for (const doc of unit.documents) {
            const buffer = await generateStatementPdfBuffer(
              labName,
              doc.data,
              label,
              logoBuffer,
              (labOrg as any)?.logoPdfSize,
              opts.invoiceScope,
              labOrg?.invoiceDueDayOfMonth ?? null,
              template.replyTo ?? null,
              statementTemplate.defaultTextBlocks,
              opts.labOrganizationId,
              statementTemplate
            );
            const base = unit.isBundle
              ? `statement-${safeName}-${sanitizeStatementFileNamePart(doc.label)}-${periodMonthStr}`
              : `statement-${safeName}-${periodMonthStr}`;
            rendered.push({
              documentKey: doc.documentKey,
              doctorName: doc.doctorName,
              label: doc.label,
              fileName: nextFileName(base),
              buffer,
              data: doc.data,
            });
          }

          // A bundle becomes durable BEFORE it is mailed: its PDFs are
          // stored and its statement row is written first. Doing this after
          // the send would let a delivery failure leave a message that no
          // retry could reproduce, and a successful send with no record of
          // what went out. Either failure throws and fails the practice.
          if (unit.isBundle && unit.providerOrganizationId) {
            persistedAttachments = await persistBundleAttachmentsOrThrow({
              providerOrganizationId: unit.providerOrganizationId,
              periodMonth: periodMonthStr,
              rendered,
            });
            issuedStatementId = await issueStatementBundleRecordOrThrow({
              labOrganizationId: opts.labOrganizationId,
              providerOrganizationId: unit.providerOrganizationId,
              summary: s,
              attachments: persistedAttachments,
              recipients,
              periodMonth: periodMonthStr,
              from: opts.from ?? null,
              to: opts.to ?? null,
              asOf: opts.asOf ?? null,
              createdByUserId: opts.triggeredByUserId ?? null,
            });
          }

          const er = await sendStatementEmail({
            to: recipients[0]!,
            cc: recipients.slice(1),
            fromName: labName,
            practiceName: unit.practiceName,
            recipientType,
            // A bundle addresses the practice; naming one of its doctors
            // here would make the shared message read as that doctor's.
            doctorName: recipientType === "doctor" ? unit.practiceName : null,
            periodLabel: label,
            attachments: rendered.map((item) => ({
              filename: item.fileName,
              content: item.buffer,
            })),
            totals: { billed: s.totalBilled, open: s.openBalance },
            template,
            labLogoUrl: emailLogoUrl,
          });
          emailStatus = er.delivered ? "sent" : "failed";
          if (!er.delivered) emailError = er.reason ?? "Email send failed";
          sentAttachments = rendered.map((item) => ({
            documentKey: item.documentKey,
            label: item.label,
            fileName: item.fileName,
            invoiceCount: item.data.invoiceCount,
          }));
        } catch (err: any) {
          emailStatus = "failed";
          emailError = err?.message ?? "Email send failed";
          logger.error(
            { err, practiceId: unit.practiceId },
            "Batch statement email failed"
          );
        }
      }
    }

    if (sendSms) {
      const phone = unit.phone ?? null;
      if (!phone) {
        smsStatus = "skipped";
        smsError = "No phone number on file";
      } else {
        try {
          const { url } = await createStatementLinkToken({
            labOrganizationId: opts.labOrganizationId,
            recipientType,
            recipientKey: unit.practiceId,
            practiceOrganizationId: unit.providerOrganizationId ?? null,
            practiceName: unit.practiceName,
            invoiceScope: opts.invoiceScope,
            from: opts.from ?? null,
            to: opts.to ?? null,
            periodLabel: label,
          });
          const sr = await sendStatementSms({
            to: phone,
            labName,
            practiceName: unit.practiceName,
            periodLabel: label,
            link: url,
          });
          smsStatus = sr.delivered ? "sent" : "failed";
          if (!sr.delivered) smsError = sr.reason ?? "SMS send failed";
        } catch (err: any) {
          smsStatus = "failed";
          smsError = err?.message ?? "SMS send failed";
          logger.error(
            { err, practiceId: unit.practiceId },
            "Batch statement SMS failed"
          );
        }
      }
    }

    const runStatus: string =
      emailStatus === "failed" || smsStatus === "failed"
        ? "failed"
        : (!sendEmail || emailStatus === "skipped") &&
            (!sendSms || smsStatus === "skipped")
          ? "skipped_no_email"
          : "sent";

    // Record the delivery outcome against the statement that was issued
    // above. History is best effort — the mail has already gone out — so a
    // failure here must not change the practice's reported result.
    if (
      issuedStatementId &&
      sendEmail &&
      // A replayed email already recorded its own history rows.
      !replayed &&
      emailStatus !== null &&
      recipients.length
    ) {
      for (const recipient of recipients) {
        await db
          .insert(practiceStatementSends)
          .values({
            statementId: issuedStatementId,
            channel: "email",
            recipient,
            status: emailStatus === "sent" ? "sent" : "failed",
            errorMessage: emailError ?? null,
            sentByUserId: opts.triggeredByUserId ?? null,
          })
          .catch((err: unknown) => {
            logger.warn(
              { err, practiceId: unit.practiceId },
              "Batch statement: send history insert failed"
            );
          });
      }
    }

    const [sendRun] = await db.insert(statementSendRuns).values({
      labOrganizationId: opts.labOrganizationId,
      // Group key (unit.practiceId) can be a doctor name; only a real org id
      // is FK-safe here. Doctor groups with no resolvable org store null.
      practiceOrganizationId: unit.providerOrganizationId ?? null,
      practiceName: unit.practiceName,
      practiceEmail: effectiveRecipients[0] ?? unit.practiceEmail,
      periodMonth: periodMonthStr,
      status: runStatus,
      errorMessage: [emailError, smsError].filter(Boolean).join("; ") || null,
      invoiceCount: s.invoiceCount,
      totalBilled: s.totalBilled.toFixed(2),
      openBalance: s.openBalance.toFixed(2),
      triggeredBy: "manual",
      triggeredByUserId: opts.triggeredByUserId,
      attemptCount: 1,
      lastAttemptAt: new Date(),
      nextAttemptAt: null,
      retryScopeJson: {
        version: 1 as const,
        invoiceScope: opts.invoiceScope,
        recipientType,
        groupKey: unit.practiceId,
        from: opts.from?.toISOString() ?? null,
        to: opts.to?.toISOString() ?? null,
        asOf: opts.asOf?.toISOString() ?? null,
        periodLabel: label,
        doctorFilters: opts.doctorFilters ?? null,
      } satisfies StatementSendRunRetryScopeContext,
      // A bundle retried from Send history must re-send the documents and
      // addresses of this send — never a freshly computed consolidated
      // statement, which would re-include excluded doctors and removed
      // addresses. Recorded even when the send was skipped, so the legacy
      // rebuild can never take over for a bundle.
      ...(unit.isBundle
        ? {
            bundleContextJson: {
              version: 1 as const,
              statementId: issuedStatementId,
              recipients: effectiveRecipients,
              periodLabel: label,
              documentKeys:
                replayed?.documentKeys ??
                unit.documents.map((doc) => doc.documentKey),
              emailSubject: template.subject,
              emailBody: template.body,
              emailHeader: template.header,
              emailReplyTo: template.replyTo,
            } satisfies StatementSendRunBundleContext,
          }
        : {}),
    }).returning();

    results.push({
      practiceId: unit.practiceId,
      practiceName: unit.practiceName,
      emailStatus,
      emailError,
      smsStatus,
      smsError,
      ...(sendRun?.id ? { runId: sendRun.id } : {}),
      ...(unit.isBundle
        ? {
            statementId: issuedStatementId,
            // Only a bundle whose documents were issued can be re-sent as
            // issued; anything else has to be built again from invoices.
            replayable: Boolean(issuedStatementId && sendRun?.id),
          }
        : {}),
      ...(unit.isBundle
        ? {
            recipients: effectiveRecipients,
            attachments:
              sentAttachments ??
              unit.documents.map((doc) => ({
                documentKey: doc.documentKey,
                label: doc.label,
                fileName: "",
                invoiceCount: doc.data.invoiceCount,
              })),
          }
        : {}),
    });
  }

  // Practices whose email was replayed and that have no unit of their own —
  // either because no SMS was requested, or because nothing is in scope for
  // them any more — still report their email outcome.
  const emitted = new Set(results.map((r) => r.practiceId));
  for (const [practiceId, replay] of replayedEmail) {
    if (emitted.has(practiceId)) continue;
    results.push({
      practiceId,
      practiceName: replay.practiceName,
      emailStatus: replay.emailStatus,
      emailError: replay.emailError,
      smsStatus: sendSms ? "skipped" : null,
      smsError: sendSms ? "No invoices in scope for this practice" : null,
      recipients: replay.recipients,
      attachments: replay.attachments,
      runId: opts.replayRuns?.[practiceId],
      statementId: replay.statementId,
      // The issued documents are still on file, so a further attempt can
      // replay them again.
      replayable: true,
    });
  }

  return { periodLabel: label, results };
}

/**
 * Generates a ZIP buffer for all matching practices — with logo — ready to
 * stream back as a download response. This keeps logo resolution out of the
 * route layer.
 */
/**
 * Generates a single PDF preview for one recipient without sending it.
 * Uses the same lab config (logo, due-day, footer) as the actual send path.
 */
export async function generateStatementPdfPreview(opts: {
  labOrganizationId: string;
  recipientType?: "practice" | "doctor";
  /** The single practiceId or composite doctor key to render. */
  recipientKey: string;
  invoiceScope: InvoiceScope;
  from?: Date | null;
  to?: Date | null;
  asOf?: Date | null;
  periodLabel?: string | null;
  invoiceIds?: string[] | null;
  /**
   * Practice mode only: preview a single doctor document out of the practice
   * bundle (the doctor name, or NO_DOCTOR_KEY for the unassigned document)
   * instead of a consolidated practice statement.
   */
  documentKey?: string | null;
  /** Practice mode only: the wizard's per-practice doctor selection. */
  doctorFilters?: Record<string, string[]> | null;
}): Promise<{ pdfBuffer: Buffer; practiceName: string }> {
  const [labOrg, sched] = await Promise.all([
    db.query.organizations.findFirst({
      where: eq(organizations.id, opts.labOrganizationId),
    }),
    db.query.statementSchedules.findFirst({
      where: eq(statementSchedules.labOrganizationId, opts.labOrganizationId),
    }),
  ]);
  const labName = labOrg?.displayName || labOrg?.name || "LabTrax";
  const effectivePlacements = resolveLocalLogoplacements(labOrg);
  const logoBuffer = effectivePlacements.has("statements")
    ? await readLogoBuffer(opts.labOrganizationId)
    : null;

  const recipientType = opts.recipientType ?? "practice";
  const documentKey = opts.documentKey?.trim() || null;

  let data: PracticeStatementData | undefined;
  if (recipientType === "practice" && documentKey) {
    // Preview the exact doctor document the email would attach, built from
    // the same bundle the send path uses.
    const bundles = await buildPracticeStatementBundles(opts.labOrganizationId, {
      scope: opts.invoiceScope,
      practiceIds: [opts.recipientKey],
      doctorFilters: opts.doctorFilters ?? null,
      from: opts.from ?? null,
      to: opts.to ?? null,
      asOf: opts.asOf ?? null,
    });
    data = bundles
      .find((bundle) => bundle.practiceId === opts.recipientKey)
      ?.documents.find((doc) => doc.documentKey === documentKey)?.data;
  } else {
    const statements = await buildPracticeStatementsForScope(
      opts.labOrganizationId,
      {
        scope: opts.invoiceScope,
        recipientType,
        practiceIds: recipientType === "practice" ? [opts.recipientKey] : null,
        doctorKeys: recipientType === "doctor" ? [opts.recipientKey] : null,
        doctorFilters:
          recipientType === "practice" ? (opts.doctorFilters ?? null) : null,
        from: opts.from ?? null,
        to: opts.to ?? null,
        asOf: opts.asOf ?? null,
      }
    );
    data = statements[0];
  }

  if (!data) {
    throw new Error("No invoices found for the selected recipient and scope.");
  }
  if (opts.invoiceIds?.length) {
    const wanted = new Set(opts.invoiceIds);
    data.invoices = data.invoices.filter((invoice) => wanted.has(invoice.id));
    if (!data.invoices.length) {
      throw new Error("No invoices found for the selected recipient and scope.");
    }
    data.invoiceCount = data.invoices.length;
    data.totalBilled = data.invoices.reduce(
      (sum, invoice) => sum + Number(invoice.total ?? 0),
      0,
    );
    data.openBalance = data.invoices.reduce(
      (sum, invoice) => sum + Number(invoice.balanceDue ?? 0),
      0,
    );
    data.totalPaid = Math.max(0, data.totalBilled - data.openBalance);
  }

  const label =
    opts.periodLabel?.trim() ||
    defaultStatementPeriodLabel();

  const pdfBuffer = await generateStatementPdfBuffer(
    labName,
    data,
    label,
    logoBuffer,
    (labOrg as any)?.logoPdfSize,
    opts.invoiceScope,
    labOrg?.invoiceDueDayOfMonth ?? null,
    sched?.emailReplyTo ?? null,
    coerceStatementTemplate((labOrg as any)?.statementTemplate).defaultTextBlocks,
    opts.labOrganizationId,
    coerceStatementTemplate((labOrg as any)?.statementTemplate)
  );

  return { pdfBuffer, practiceName: data.practiceName };
}
export async function generateStatementsZipBufferForLab(opts: {
  labOrganizationId: string;
  recipientType?: "practice" | "doctor";
  practiceIds?: string[] | null;
  doctorKeys?: string[] | null;
  doctorFilters?: Record<string, string[]> | null;
  invoiceScope: InvoiceScope;
  from?: Date | null;
  to?: Date | null;
  asOf?: Date | null;
  periodLabel?: string | null;
}): Promise<{ zipBuffer: Buffer; filename: string; periodLabel: string }> {
  const [labOrg, zipSched] = await Promise.all([
    db.query.organizations.findFirst({
      where: eq(organizations.id, opts.labOrganizationId),
    }),
    db.query.statementSchedules.findFirst({
      where: eq(statementSchedules.labOrganizationId, opts.labOrganizationId),
    }),
  ]);
  const labName = labOrg?.displayName || labOrg?.name || "LabTrax";
  const effectivePlacements = resolveLocalLogoplacements(labOrg);
  const logoBuffer = effectivePlacements.has("statements")
    ? await readLogoBuffer(opts.labOrganizationId)
    : null;

  const label =
    opts.periodLabel?.trim() || defaultStatementPeriodLabel();

  const recipientType = opts.recipientType ?? "practice";
  // Practice mode downloads exactly the per-doctor documents the matching
  // email would attach, so a preview, a ZIP, and a send never disagree.
  const entries: Array<{ name: string; data: PracticeStatementData }> = [];
  if (recipientType === "practice") {
    const bundles = await buildPracticeStatementBundles(opts.labOrganizationId, {
      scope: opts.invoiceScope,
      practiceIds: opts.practiceIds ?? null,
      doctorFilters: opts.doctorFilters ?? null,
      from: opts.from ?? null,
      to: opts.to ?? null,
      asOf: opts.asOf ?? null,
    });
    const nextFileName = createStatementFileNamer();
    for (const bundle of bundles) {
      const safePractice = sanitizeStatementFileNamePart(bundle.practiceName);
      for (const doc of bundle.documents) {
        entries.push({
          name: nextFileName(
            `statement-${safePractice}-${sanitizeStatementFileNamePart(doc.label)}`
          ),
          data: doc.data,
        });
      }
    }
  } else {
    const statements = await buildPracticeStatementsForScope(
      opts.labOrganizationId,
      {
        scope: opts.invoiceScope,
        recipientType,
        practiceIds: opts.practiceIds ?? null,
        doctorKeys: opts.doctorKeys ?? null,
        doctorFilters: opts.doctorFilters ?? null,
        from: opts.from ?? null,
        to: opts.to ?? null,
        asOf: opts.asOf ?? null,
      }
    );
    const nextFileName = createStatementFileNamer();
    for (const s of statements) {
      entries.push({
        name: nextFileName(`statement-${sanitizeStatementFileNamePart(s.practiceName)}`),
        data: s,
      });
    }
  }

  if (!entries.length) {
    throw new Error("No invoices found for the selected practices and scope.");
  }

  const zipBuffer = await generateStatementsZipBufferFromEntries(
    labName,
    entries,
    label,
    logoBuffer,
    (labOrg as any)?.logoPdfSize,
    opts.invoiceScope,
    labOrg?.invoiceDueDayOfMonth ?? null,
    zipSched?.emailReplyTo ?? null,
    coerceStatementTemplate((labOrg as any)?.statementTemplate).defaultTextBlocks,
    opts.labOrganizationId,
    coerceStatementTemplate((labOrg as any)?.statementTemplate)
  );
  const dateStr = new Date().toISOString().slice(0, 10);
  return { zipBuffer, filename: `statements-${dateStr}.zip`, periodLabel: label };
}

export async function processDueRetries(asOf: Date = new Date()): Promise<{
  attempted: number;
  succeeded: number;
  failed: number;
}> {
  const due = await db
    .select({ id: statementSendRuns.id })
    .from(statementSendRuns)
    .where(
      and(
        eq(statementSendRuns.status, "failed"),
        lt(statementSendRuns.attemptCount, STATEMENT_MAX_ATTEMPTS),
        // nextAttemptAt is set when more retries remain
        lte(statementSendRuns.nextAttemptAt, asOf)
      )
    )
    .limit(100);

  let succeeded = 0;
  let failed = 0;
  for (const row of due) {
    try {
      const r = await attemptStatementSendForRun(row.id);
      if (r.status === "sent") succeeded += 1;
      else if (r.status === "failed") failed += 1;
    } catch (err: unknown) {
      failed += 1;
      logger.error(
        { err, runId: row.id },
        "Unexpected error while retrying statement send"
      );
    }
  }
  if (due.length) {
    logger.info(
      { attempted: due.length, succeeded, failed },
      "Statement retry tick complete"
    );
  }
  return { attempted: due.length, succeeded, failed };
}

// ── Daily scheduler ─────────────────────────────────────────────────────────
// Wakes once per day and processes any enabled lab schedules whose
// `dayOfMonth` matches today (clamped to last day of month) and that have
// not yet been sent for the prior month.

let scheduled = false;

function msUntilNextHour(hourUtc: number): number {
  const now = new Date();
  const next = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      hourUtc,
      5,
      0,
      0
    )
  );
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.getTime() - now.getTime();
}

function lastDayOfMonth(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

export async function processDueSchedules(asOf: Date = new Date()): Promise<void> {
  const todayDay = asOf.getUTCDate();
  const lastDay = lastDayOfMonth(asOf.getUTCFullYear(), asOf.getUTCMonth());
  const { periodMonth } = priorMonthRange(asOf);

  const due = await db.query.statementSchedules.findMany({
    where: eq(statementSchedules.enabled, true),
  });

  for (const sched of due) {
    // dayOfMonth = 0 means "last day of month" — fire on the true last calendar
    // day of the current month. Values 1–31 are clamped to the month's actual
    // length so admins picking 31 still get sent on Feb 28/29, Apr 30, etc.
    const target =
      sched.dayOfMonth === 0
        ? lastDay
        : Math.min(Math.max(1, sched.dayOfMonth), lastDay);
    // Catch-up semantics: run any time on or after the target day this month
    // if we have not yet sent for the prior month. This covers brief outages
    // and process restarts on the target day without resending.
    if (todayDay < target) continue;
    if (sched.lastSentForMonth === periodMonth) continue;

    // DB-level in-progress lease: atomically claim the (lab, periodMonth)
    // run so a concurrent tick / second app instance cannot double-send.
    // The lease is short-lived (LEASE_MS) so a crash mid-run leaves it
    // recoverable on the next tick instead of permanently blocking the
    // month. lastSentForMonth is only stamped after the run completes.
    const LEASE_MS = 30 * 60 * 1000; // 30 minutes
    const leaseCutoff = new Date(asOf.getTime() - LEASE_MS);
    const claimed = await db
      .update(statementSchedules)
      .set({ inProgressForMonth: periodMonth, inProgressLeasedAt: asOf })
      .where(
        and(
          eq(statementSchedules.id, sched.id),
          // Don't reclaim a period we've already finished sending.
          or(
            isNull(statementSchedules.lastSentForMonth),
            ne(statementSchedules.lastSentForMonth, periodMonth)
          ),
          // Acquire only when no live lease exists for this period.
          or(
            isNull(statementSchedules.inProgressForMonth),
            ne(statementSchedules.inProgressForMonth, periodMonth),
            isNull(statementSchedules.inProgressLeasedAt),
            lt(statementSchedules.inProgressLeasedAt, leaseCutoff)
          )
        )
      )
      .returning({ id: statementSchedules.id });
    if (!claimed.length) continue;

    try {
      logger.info(
        { labOrganizationId: sched.labOrganizationId, periodMonth },
        "Running scheduled monthly statements"
      );
      const result = await runMonthlyStatementsForLab({
        labOrganizationId: sched.labOrganizationId,
        triggeredBy: "schedule",
        asOf,
      });
      const sent = result.results.filter((r) => r.status === "sent").length;
      const failed = result.results.filter((r) => r.status === "failed").length;
      const skipped = result.results.filter(
        (r) => r.status === "skipped_no_email"
      ).length;
      const optedOut = result.results.filter(
        (r) => r.status === "skipped_opted_out"
      ).length;
      logger.info(
        {
          labOrganizationId: sched.labOrganizationId,
          periodMonth,
          sent,
          failed,
          skipped,
          optedOut,
        },
        "Scheduled monthly statements complete"
      );
      // Mark the period fully sent only on completion. We treat any
      // delivery attempt (sent / failed / skipped_no_email) as a recorded
      // outcome for this lab+period; the per-practice statementSendRuns
      // table is the source of truth, so we don't auto-retry the whole lab
      // on the next day. Individual failed practices can be retried by an
      // admin via "Send last month now" or a future per-row retry.
      await db
        .update(statementSchedules)
        .set({
          lastSentForMonth: periodMonth,
          lastRunAt: new Date(),
          inProgressForMonth: null,
          inProgressLeasedAt: null,
        })
        .where(eq(statementSchedules.id, sched.id));
    } catch (err: unknown) {
      // Release the lease so the next tick (today or tomorrow) retries.
      // lastSentForMonth is intentionally NOT set, so the period stays
      // claim-eligible.
      await db
        .update(statementSchedules)
        .set({ inProgressForMonth: null, inProgressLeasedAt: null })
        .where(eq(statementSchedules.id, sched.id))
        .catch(() => {
          /* swallow: best-effort lease release */
        });
      logger.error(
        { err, labOrganizationId: sched.labOrganizationId, periodMonth },
        "Scheduled statement run failed; lease released for retry"
      );
    }
  }
}

export function startStatementScheduler() {
  if (scheduled) return;
  scheduled = true;
  const hourUtc = Math.max(
    0,
    Math.min(
      23,
      parseInt(process.env.STATEMENTS_HOUR_UTC || "8", 10) || 8
    )
  );
  const tick = async () => {
    try {
      await processDueSchedules(new Date());
    } catch (err: unknown) {
      logger.error({ err }, "Statement scheduler tick failed");
    } finally {
      setTimeout(tick, msUntilNextHour(hourUtc));
    }
  };
  const initial = msUntilNextHour(hourUtc);
  logger.info(
    { hourUtc, firstRunInMin: Math.round(initial / 60000) },
    "Monthly statement scheduler armed"
  );
  setTimeout(tick, initial);

  // Independent retry tick: runs every RETRY_INTERVAL_MS to pick up any
  // failed sends whose backoff has elapsed. Decoupled from the once-a-day
  // schedule tick so retries don't have to wait for tomorrow.
  const RETRY_INTERVAL_MS = Math.max(
    60 * 1000,
    parseInt(process.env.STATEMENTS_RETRY_INTERVAL_MS || "", 10) ||
      15 * 60 * 1000
  );
  const retryTick = async () => {
    try {
      await processDueRetries(new Date());
    } catch (err: unknown) {
      logger.error({ err }, "Statement retry tick failed");
    } finally {
      setTimeout(retryTick, RETRY_INTERVAL_MS);
    }
  };
  // Stagger initial retry tick a bit after boot so we don't hammer SMTP
  // at the same moment as the daily scheduler tick.
  setTimeout(retryTick, Math.min(RETRY_INTERVAL_MS, 2 * 60 * 1000));
  logger.info(
    { intervalMs: RETRY_INTERVAL_MS },
    "Statement retry scheduler armed"
  );
}

export const DEFAULT_STATEMENT_BODY_DOCTOR =
  "Hello {{doctorName}},\n\nPlease find attached the statement for {{practiceName}} covering {{periodLabel}}.\n\nThank you,\n{{labName}}";

export async function attachStatementContacts(
  labOrganizationId: string,
  statements: PracticeStatementData[],
): Promise<void> {
  if (!statements.length) return;
  const providerIds = Array.from(
    new Set(
      statements
        .map((statement) => statement.providerOrganizationId)
        .filter((id): id is string => !!id),
    ),
  );
  const organizationIds = Array.from(new Set([labOrganizationId, ...providerIds]));
  const [orgRows, additionalRows] = await Promise.all([
    db
      .select()
      .from(organizations)
      .where(inArray(organizations.id, organizationIds)),
    (async () => {
      let additionalTable: any;
      try {
        additionalTable = (dbSchema as any).organizationAdditionalEmails;
      } catch {
        return [] as Array<{ organizationId: string; email: string }>;
      }
      if (!additionalTable) {
        return [] as Array<{ organizationId: string; email: string }>;
      }
      return db
        .select({
          organizationId: additionalTable.organizationId,
          email: additionalTable.email,
        })
        .from(additionalTable)
        .where(inArray(additionalTable.organizationId, organizationIds));
    })(),
  ]);
  const orgById = new Map(orgRows.map((organization) => [organization.id, organization]));
  const additionalByOrg = new Map<string, string[]>();
  for (const row of additionalRows) {
    const email = cleanContactValue(row.email);
    if (!email) continue;
    const current = additionalByOrg.get(row.organizationId) ?? [];
    current.push(email);
    additionalByOrg.set(row.organizationId, current);
  }

  const labContact = contactFromOrganization(
    orgById.get(labOrganizationId),
    additionalByOrg.get(labOrganizationId) ?? [],
  );

  for (const statement of statements) {
    const providerId = statement.providerOrganizationId ?? null;
    const practiceContact = contactFromOrganization(
      providerId ? orgById.get(providerId) : null,
      providerId ? additionalByOrg.get(providerId) ?? [] : [],
    );
    statement.labContact = labContact;
    statement.practiceContact = practiceContact;
    statement.phone = practiceContact?.phone ?? statement.phone ?? null;

    if (statement.recipientType !== "doctor" || !providerId) continue;
    const doctorName =
      statement.practiceName === NO_DOCTOR_LABEL ? null : statement.practiceName;
    const profileQuery = db.query.doctorProfiles;
    if (!doctorName || typeof profileQuery?.findFirst !== "function") {
      continue;
    }
    const providerClause = eq(
      doctorProfiles.providerOrganizationId,
      providerId,
    );
    // Drizzle's relational query methods read schema/session state from `this`.
    // Keep the query object as the receiver instead of extracting findFirst.
    const profile = await profileQuery.findFirst({
      where: and(
        eq(doctorProfiles.labOrganizationId, labOrganizationId),
        sql`lower(${doctorProfiles.doctorName}) = lower(${doctorName})`,
        providerClause,
      ),
    });
    if (!profile) continue;
    const [phones, emails] = await Promise.all([
      (db.query as any).doctorPhoneEntries?.findMany?.({
        where: eq(doctorPhoneEntries.doctorProfileId, profile.id),
      }) ?? [],
      (db.query as any).doctorEmailEntries?.findMany?.({
        where: eq(doctorEmailEntries.doctorProfileId, profile.id),
      }) ?? [],
    ]);
    statement.doctorContact = {
      displayName: cleanContactValue(profile.displayName) ?? cleanContactValue(profile.doctorName),
      legalName: cleanContactValue(profile.doctorName),
      addressLine1: null,
      addressLine2: null,
      city: null,
      state: null,
      zip: null,
      phone: cleanContactValue(phones.find((phone: any) => phone.isPrimary)?.phoneNumber)
        ?? cleanContactValue(phones[0]?.phoneNumber),
      billingEmail: cleanContactValue(emails.find((email: any) => email.isPrimary)?.email)
        ?? cleanContactValue(emails[0]?.email),
      additionalEmails: [],
      accountNumber: null,
      licenseNumber: null,
      phones: phones
        .map((phone: any) => cleanContactValue(phone.phoneNumber))
        .filter((v: string | null): v is string => !!v),
      emails: emails
        .map((email: any) => cleanContactValue(email.email))
        .filter((v: string | null): v is string => !!v),
    };
  }
}

function doctorContactLines(
  doctor: StatementContactBlock | null | undefined,
  practice: StatementContactBlock | null | undefined,
): string[] {
  const lines: string[] = [];
  if (doctor) {
    if (doctor.displayName) lines.push(doctor.displayName);
    for (const phone of doctor.phones) lines.push(`Phone: ${phone}`);
    for (const email of doctor.emails) lines.push(`Email: ${email}`);
  }
  const practiceLines = contactLines(practice);
  if (practiceLines.length) lines.push("Practice context", ...practiceLines);
  return lines;
}

async function readTemplateImageBuffer(
  labOrganizationId: string | null | undefined,
  storageKey: string,
): Promise<Buffer | null> {
  if (!labOrganizationId) return null;
  const match = storageKey.match(/\/([A-Za-z0-9_-]+)\.[A-Za-z0-9]+$/);
  if (!match) return null;
  try {
    const result = await openInvoiceTemplateImageStream(
      labOrganizationId,
      match[1]!,
    );
    if (!result || result.contentType.includes("svg")) return null;
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      result.stream.on("data", (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      result.stream.on("end", resolve);
      result.stream.on("error", reject);
    });
    return Buffer.concat(chunks);
  } catch {
    return null;
  }
}

function drawBoundedText(
  doc: any,
  box: { x: number; y: number; w: number; h: number },
  text: string,
  options: {
    fontSize?: number;
    font?: string;
    color?: string;
    align?: "left" | "center" | "right";
    padding?: number;
  } = {},
): void {
  const padding = options.padding ?? 5;
  if (!text.trim() || box.w <= padding * 2 || box.h <= padding * 2) return;
  doc.save();
  doc.rect(box.x, box.y, box.w, box.h).clip();
  doc
    .font(options.font ?? "Helvetica")
    .fontSize(options.fontSize ?? 9)
    .fillColor(options.color ?? "#000")
    .text(text, box.x + padding, box.y + padding, {
      width: Math.max(1, box.w - padding * 2),
      height: Math.max(1, box.h - padding * 2),
      align: options.align ?? "left",
      lineGap: 1,
    });
  doc.restore();
}

function contactFromOrganization(
  organization: any,
  additionalEmails: string[] = [],
): StatementContactBlock | null {
  if (!organization) return null;
  return {
    displayName: cleanContactValue(organization.displayName),
    legalName: cleanContactValue(organization.name),
    addressLine1: cleanContactValue(organization.addressLine1),
    addressLine2: cleanContactValue(organization.addressLine2),
    city: cleanContactValue(organization.city),
    state: cleanContactValue(organization.state),
    zip: cleanContactValue(organization.zip),
    phone: cleanContactValue(organization.phone),
    billingEmail: cleanContactValue(organization.billingEmail),
    additionalEmails: additionalEmails.map(cleanContactValue).filter((v): v is string => !!v),
    accountNumber: cleanContactValue(organization.accountNumber),
    licenseNumber: cleanContactValue(organization.licenseNumber),
    phones: [],
    emails: [],
  };
}
