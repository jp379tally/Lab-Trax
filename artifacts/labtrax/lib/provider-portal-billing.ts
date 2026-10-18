// Billing data and parity rules for the provider portal's
// "View and Pay My Bill" section.
//
// Everything here is a port of the desktop screen's own logic
// (artifacts/labtrax-desktop/src/components/provider/ProviderBilling.tsx and
// PayMyBillDialog.tsx), kept in a separate module so the mobile section can
// render it and the tests can exercise the rules directly. The numbers and
// wording must match desktop for the same account, so the thresholds
// (0.005), the filter bounds and the fallbacks below are deliberately
// identical rather than "equivalent".
//
// Fetching reuses the existing mobile provider helpers — provider-billing.ts
// for statements/balances/history/preferences and provider-api.ts for the
// provider case list — instead of opening a parallel request path.
import { getJson } from "@/lib/read-api";
import { providerRequest } from "@/lib/provider-api";
import {
  getProviderAccountBalance,
  type ProviderStatement,
} from "@/lib/provider-billing";

// ── Types ──────────────────────────────────────────────────────────────────

/** One invoice on a statement, as `/api/invoices/:id` returns it. */
export interface StatementInvoice {
  id: string;
  invoiceNumber: string;
  status: string;
  total?: string | number | null;
  balanceDue?: string | number | null;
  currentBalanceDue?: string | number | null;
  eligibleForPayment?: boolean;
  /** ISO timestamp — preferred sort key for oldest-first allocation. */
  issuedAt?: string | null;
  /** ISO timestamp — fallback sort key when issuedAt is absent. */
  createdAt?: string | null;
  displayMetadata?: { patientName?: string | null } | null;
}

/** A provider case row from `/api/cases/provider`. */
export interface ProviderPortalCase {
  id: string;
  caseNumber?: string | null;
  patientFirstName?: string | null;
  patientLastName?: string | null;
  patientName?: string | null;
  restorationTypes?: string | null;
  status?: string | null;
  dueDate?: string | null;
  labName?: string | null;
  openInvoiceAmount?: number | null;
}

/** The slice of the account-balance payload the summary reads. */
export interface PortalAccountBalance {
  /**
   * Which lab ↔ provider relationship this balance belongs to. Carried so an
   * account-wide payment can name the relationship it is settling instead of
   * pairing balances with statements by array position.
   */
  labOrganizationId: string;
  providerOrganizationId: string;
  currentBalance: string | number;
  openInvoiceCount: number;
}

/**
 * One provider account that can be paid in full in a single checkout.
 *
 * A relationship's balance spans every open statement it has, so this is not
 * the same as paying one statement: the server resolves "full" against every
 * currently payable invoice for the provider organization.
 */
export interface PayableProviderAccount {
  labOrganizationId: string;
  providerOrganizationId: string;
  labName: string | null;
  currentBalance: number;
}

export type PaymentHistoryRow = {
  id: string;
  paidAt: string | null;
  invoiceId: string;
  invoiceNumber: string | null;
  patientName: string | null;
  amount: string | number | null;
  paymentMethod: string | null;
  referenceNumber?: string | null;
};

export type PastStatementsFilter = "this_year" | "last_year" | "custom";
export type HistoryFilter = "this_month" | "last_month" | "custom";

// Practice-scoped query keys (see PRACTICE_SCOPED_QUERY_PREFIXES in
// provider-practice.tsx — switching practices must drop this data).
export const PROVIDER_PORTAL_CASES_QUERY_KEY = ["provider-cases", "portal"] as const;
export const PROVIDER_ACCOUNT_BALANCES_QUERY_KEY = [
  "provider-billing",
  "account-balances",
] as const;

// ── Shared numeric / formatting rules ──────────────────────────────────────

export function balanceDueNum(val: string | number | null | undefined): number {
  if (val == null) return 0;
  const n = typeof val === "string" ? parseFloat(val) : val;
  return isNaN(n) ? 0 : n;
}

export function formatCurrency(val: string | number | null | undefined): string {
  if (val == null) return "—";
  const n = typeof val === "string" ? parseFloat(val) : val;
  if (isNaN(n)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(n);
}

/** Desktop's case-table money column: a zero balance reads as "—". */
export function formatCurrencyNum(amount: number | null | undefined): string {
  if (amount == null || amount === 0) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(amount);
}

export function formatStatementDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  try {
    return new Date(dateStr).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return dateStr;
  }
}

export function statusLabel(status: string): string {
  return status
    .split(/[_\s]+/)
    .map((p) => (p ? p[0].toUpperCase() + p.slice(1) : p))
    .join(" ");
}

export const PAYMENT_METHOD_DISPLAY: Record<string, string> = {
  card: "Card",
  ach: "ACH",
  check: "Check",
  cash: "Cash",
  other: "Other",
};

// ── Statements ─────────────────────────────────────────────────────────────

/**
 * Split statements the way desktop does: anything still carrying a balance is
 * "open", everything else belongs in the past-statements archive. A statement
 * that gets paid therefore moves across on the next refresh.
 */
export function partitionStatements(statements: ProviderStatement[] | null | undefined): {
  open: ProviderStatement[];
  past: ProviderStatement[];
} {
  if (!Array.isArray(statements)) return { open: [], past: [] };
  return {
    open: statements.filter((s) => balanceDueNum(s.balanceDue) > 0.005),
    past: statements.filter((s) => balanceDueNum(s.balanceDue) <= 0.005),
  };
}

export function filterPastStatements(
  pastStatements: ProviderStatement[],
  options: {
    filter: PastStatementsFilter;
    customFrom?: string;
    customTo?: string;
    search?: string;
    now?: Date;
  },
): ProviderStatement[] {
  if (pastStatements.length === 0) return [];
  const now = options.now ?? new Date();
  const { filter, customFrom = "", customTo = "", search = "" } = options;

  let dateFiltered: ProviderStatement[];
  if (filter === "this_year" || filter === "last_year") {
    const year = filter === "this_year" ? now.getFullYear() : now.getFullYear() - 1;
    const start = new Date(year, 0, 1);
    const end = new Date(year, 11, 31, 23, 59, 59, 999);
    dateFiltered = pastStatements.filter((s) => {
      if (!s.statementDate) return true;
      const d = new Date(s.statementDate);
      return d >= start && d <= end;
    });
  } else {
    dateFiltered = pastStatements.filter((s) => {
      if (!s.statementDate) return true;
      const d = new Date(s.statementDate);
      if (customFrom) {
        const from = new Date(`${customFrom}T00:00:00`);
        if (d < from) return false;
      }
      if (customTo) {
        const to = new Date(`${customTo}T23:59:59.999`);
        if (d > to) return false;
      }
      return true;
    });
  }

  // One search box across lab name, the formatted/raw statement date and the
  // invoice count — the same fields desktop matches on.
  const trimmed = search.trim().toLowerCase();
  if (!trimmed) return dateFiltered;
  return dateFiltered.filter((s) => {
    const labMatch = (s.labName ?? "").toLowerCase().includes(trimmed);
    const formattedDateMatch = formatStatementDate(s.statementDate)
      .toLowerCase()
      .includes(trimmed);
    const rawDateMatch = (s.statementDate ?? "").toLowerCase().includes(trimmed);
    const invoiceCountMatch =
      s.invoiceCount != null && String(s.invoiceCount).includes(trimmed);
    return labMatch || formattedDateMatch || rawDateMatch || invoiceCountMatch;
  });
}

/**
 * Best-effort guess at which field the provider meant, so the "no match"
 * empty state can name it: a plain number reads as an invoice count, a digit
 * paired with a slash/dash/month name reads as a date, anything else is a
 * lab name.
 */
export function pastStatementsSearchFieldGuess(
  search: string,
): "invoiceCount" | "date" | "labName" {
  const t = search.trim();
  if (!t) return "labName";
  if (/^\d+$/.test(t)) return "invoiceCount";
  const monthNamePattern = /jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec/i;
  if (/\d/.test(t) && (/[-/]/.test(t) || monthNamePattern.test(t))) return "date";
  return "labName";
}

// ── Payment history ────────────────────────────────────────────────────────

export function filterPaymentHistory(
  rows: PaymentHistoryRow[] | null | undefined,
  options: {
    filter: HistoryFilter;
    customFrom?: string;
    customTo?: string;
    now?: Date;
  },
): PaymentHistoryRow[] {
  if (!rows) return [];
  const now = options.now ?? new Date();
  const { filter, customFrom = "", customTo = "" } = options;

  if (filter === "this_month" || filter === "last_month") {
    const monthOffset = filter === "this_month" ? 0 : -1;
    const start = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
    const end = new Date(
      now.getFullYear(),
      now.getMonth() + monthOffset + 1,
      0,
      23,
      59,
      59,
      999,
    );
    return rows.filter((p) => {
      if (!p.paidAt) return false;
      const d = new Date(p.paidAt);
      return d >= start && d <= end;
    });
  }

  return rows.filter((p) => {
    if (!p.paidAt) return false;
    const d = new Date(p.paidAt);
    if (customFrom) {
      const from = new Date(`${customFrom}T00:00:00`);
      if (d < from) return false;
    }
    if (customTo) {
      const to = new Date(`${customTo}T23:59:59.999`);
      if (d > to) return false;
    }
    return true;
  });
}

// ── Outstanding summary ────────────────────────────────────────────────────

export function openCasesOf(
  cases: ProviderPortalCase[] | null | undefined,
): ProviderPortalCase[] {
  if (!cases) return [];
  return cases.filter((c) => (c.openInvoiceAmount ?? 0) > 0);
}

/** More than one lab in the case list means the lab column is shown. */
export function isMultiLab(cases: ProviderPortalCase[] | null | undefined): boolean {
  if (!cases) return false;
  return new Set(cases.map((c) => c.labName).filter(Boolean)).size > 1;
}

/**
 * Outstanding total and open-invoice count. Account balances are the truth
 * when any relationship reported one; the open cases are the fallback so the
 * summary still says something useful before (or without) balances.
 */
export function summarizeOutstanding(
  accountBalances: PortalAccountBalance[],
  cases: ProviderPortalCase[] | null | undefined,
): { totalOpenBalance: number; openCaseCount: number } {
  const openCases = openCasesOf(cases);
  if (accountBalances.length > 0) {
    return {
      totalOpenBalance: accountBalances.reduce(
        (sum, balance) => sum + Number(balance.currentBalance || 0),
        0,
      ),
      openCaseCount: accountBalances.reduce(
        (sum, balance) => sum + Number(balance.openInvoiceCount || 0),
        0,
      ),
    };
  }
  return {
    totalOpenBalance: openCases.reduce((sum, c) => sum + (c.openInvoiceAmount ?? 0), 0),
    openCaseCount: openCases.length,
  };
}

/**
 * The provider accounts that currently owe something, named by their lab.
 *
 * Statements supply the lab name; the balance is the relationship's live
 * figure, which covers every open statement it has. A relationship with
 * nothing outstanding is left out — there is no full balance to pay.
 */
export function payableAccountsOf(
  accountBalances: PortalAccountBalance[],
  statements: ProviderStatement[] | null | undefined,
): PayableProviderAccount[] {
  const labNames = new Map<string, string | null>();
  for (const statement of statements ?? []) {
    const key = `${statement.labOrganizationId}:${statement.providerOrganizationId}`;
    if (!labNames.has(key) || (labNames.get(key) == null && statement.labName != null)) {
      labNames.set(key, statement.labName ?? null);
    }
  }
  const accounts: PayableProviderAccount[] = [];
  for (const balance of accountBalances) {
    if (!balance.providerOrganizationId) continue;
    const currentBalance = Number(balance.currentBalance || 0);
    if (!(currentBalance > 0)) continue;
    accounts.push({
      labOrganizationId: balance.labOrganizationId,
      providerOrganizationId: balance.providerOrganizationId,
      labName:
        labNames.get(`${balance.labOrganizationId}:${balance.providerOrganizationId}`) ??
        null,
      currentBalance,
    });
  }
  return accounts;
}

// ── Payment allocation (ported from PayMyBillDialog) ───────────────────────

export const PAYABLE_STATUSES = new Set(["open", "partially_paid", "overdue"]);

export function isPayable(invoice: StatementInvoice): boolean {
  const eligible = invoice.eligibleForPayment ??
    PAYABLE_STATUSES.has(invoice.status);
  return eligible &&
    balanceDueNum(invoice.currentBalanceDue ?? invoice.balanceDue) > 0.005;
}

function invoiceChronologicalKey(inv: StatementInvoice): number {
  const ts = inv.issuedAt ?? inv.createdAt;
  if (!ts) return Infinity;
  const ms = new Date(ts).getTime();
  return isNaN(ms) ? Infinity : ms;
}

/**
 * Distribute `total` dollars across open invoices oldest-first, returning the
 * invoices that receive a non-zero allocation.
 */
export function allocatePayment(
  invoices: StatementInvoice[],
  total: number,
): { invoiceId: string; amount: number }[] {
  const sorted = [...invoices]
    .filter(isPayable)
    .sort((a, b) => invoiceChronologicalKey(a) - invoiceChronologicalKey(b));

  const result: { invoiceId: string; amount: number }[] = [];
  let remaining = total;

  for (const inv of sorted) {
    if (remaining <= 0.005) break;
    const cap = balanceDueNum(inv.currentBalanceDue ?? inv.balanceDue);
    const apply = Math.min(remaining, cap);
    if (apply > 0.005) {
      result.push({ invoiceId: inv.id, amount: Math.round(apply * 100) / 100 });
      remaining -= apply;
    }
  }

  return result;
}

// ── Invoice auto-pay (shared by every surface that edits it) ───────────────

/** The charge-day window the server accepts: bills are due by the 10th. */
export const AUTO_PAY_CHARGE_DAY_MIN = 1;
export const AUTO_PAY_CHARGE_DAY_MAX = 10;

/** An in-progress edit of one lab's invoice auto-pay preference. */
export interface AutoPayDraft {
  enabled: boolean;
  /** Free text while editing — "" means "no day chosen". */
  chargeDay: string;
}

/** The draft a saved preference starts from. */
export function autoPayDraftOf(
  preference: { enabled: boolean; chargeDay: number | null } | null | undefined,
): AutoPayDraft {
  return {
    enabled: preference?.enabled === true,
    chargeDay: preference?.chargeDay != null ? String(preference.chargeDay) : "",
  };
}

/**
 * Read a typed charge day, or explain why it cannot be saved.
 *
 * An empty box is not an error: it means the provider has not chosen a day,
 * which the server stores as "keep the existing day". Anything else has to be
 * a whole number inside the due-by-the-10th window, because a day the server
 * rejects would otherwise look saved on one screen and unsaved on the next.
 */
export function parseAutoPayChargeDay(
  raw: string,
): { ok: true; chargeDay: number | null } | { ok: false; message: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, chargeDay: null };
  const chargeDay = Number(trimmed);
  if (
    !Number.isInteger(chargeDay) ||
    chargeDay < AUTO_PAY_CHARGE_DAY_MIN ||
    chargeDay > AUTO_PAY_CHARGE_DAY_MAX
  ) {
    return {
      ok: false,
      message: `Invoice auto-pay charge day must be from ${AUTO_PAY_CHARGE_DAY_MIN} through ${AUTO_PAY_CHARGE_DAY_MAX}.`,
    };
  }
  return { ok: true, chargeDay };
}

// ── Fetching ───────────────────────────────────────────────────────────────

/**
 * Balances for every lab ↔ provider relationship that appears in the
 * statements, deduplicated the way desktop does. A relationship whose balance
 * call fails falls back to the statement's own figures rather than dropping
 * out of the summary.
 */
export async function getProviderAccountBalances(
  statements: ProviderStatement[],
): Promise<PortalAccountBalance[]> {
  const relationships = Array.from(
    new Map(
      statements.map((statement) => [
        `${statement.labOrganizationId}:${statement.providerOrganizationId}`,
        statement,
      ]),
    ).values(),
  );
  return Promise.all(
    relationships.map((relationship) =>
      getProviderAccountBalance(
        relationship.labOrganizationId,
        relationship.providerOrganizationId,
      ).catch(() => ({
        labOrganizationId: relationship.labOrganizationId,
        providerOrganizationId: relationship.providerOrganizationId,
        currentBalance: String(relationship.balanceDue ?? 0),
        openInvoiceCount: Number(relationship.invoiceCount ?? 0),
      })),
    ),
  );
}

export async function getProviderPortalCases(): Promise<ProviderPortalCase[]> {
  return providerRequest<ProviderPortalCase[]>("/api/cases/provider");
}

/**
 * Load every invoice on a statement, all or nothing.
 *
 * Desktop opens Pay My Bill only once all of them resolve: a partial list
 * would let the provider pay against a balance that is not the statement's.
 * One rejection here therefore rejects the whole call.
 */
export async function loadStatementInvoices(
  statementId: string,
): Promise<StatementInvoice[]> {
  const detail = await getJson<{ invoices: StatementInvoice[] }>(
    `/api/provider/statements/${encodeURIComponent(statementId)}`,
  );
  return detail.invoices;
}
