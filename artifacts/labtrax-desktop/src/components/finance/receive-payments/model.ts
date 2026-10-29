import { AgingBucketKey } from "@/lib/ap-types";
import type {
  CustomerScope,
  EligibleAccount,
  SavedSelection,
  Selection,
  StatementInvoice,
} from "./types";

/**
 * The selection model behind Receive Payments: one row per customer with
 * something payable, merged from the statement-led and invoice-led
 * eligibility lists, plus the pure helpers the tabs, heads-up cards and
 * Payment Summary share so they always agree.
 */

/** The A/R Aging report's buckets, youngest first, with the report's labels. */
export const AGING_BUCKETS: ReadonlyArray<{ key: AgingBucketKey; label: string; filterLabel: string }> = [
  { key: AgingBucketKey.current, label: "Current", filterLabel: "Current" },
  { key: AgingBucketKey.d1_30, label: "1 - 30", filterLabel: "1 - 30 days" },
  { key: AgingBucketKey.d31_60, label: "31 - 60", filterLabel: "31 - 60 days" },
  { key: AgingBucketKey.d61_90, label: "61 - 90", filterLabel: "61 - 90 days" },
  { key: AgingBucketKey.d90_plus, label: "Over 90", filterLabel: "Over 90 days" },
];

export function agingBucketLabel(key: AgingBucketKey): string {
  return AGING_BUCKETS.find((bucket) => bucket.key === key)?.label ?? key;
}

const DAY_MS = 86_400_000;

/**
 * Today's "as of" moment for aging: the end of the local calendar day, the
 * same cut-off the A/R Aging report uses for today.
 */
export function agingAsOf(now: Date = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
}

/**
 * Whole days past due, as the A/R Aging report counts them: from the due date,
 * or the invoice date when there is no due date. Null when neither is known.
 */
export function daysPastDue(agingDate: string | null | undefined, asOf: Date): number | null {
  if (!agingDate) return null;
  const time = new Date(agingDate).getTime();
  if (Number.isNaN(time)) return null;
  return Math.floor((asOf.getTime() - time) / DAY_MS);
}

/** The A/R Aging bucket for a days-past-due figure. Not yet due, including due today, is current. */
export function agingBucket(days: number | null): AgingBucketKey {
  if (days === null || days <= 0) return AgingBucketKey.current;
  if (days <= 30) return AgingBucketKey.d1_30;
  if (days <= 60) return AgingBucketKey.d31_60;
  if (days <= 90) return AgingBucketKey.d61_90;
  return AgingBucketKey.d90_plus;
}

const amountOf = (value: string | number | null | undefined): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};
const cents = (value: number): number => Math.round(value * 100) / 100;
const balanceOf = (invoice: StatementInvoice): number =>
  amountOf(invoice.currentBalanceDue || invoice.currentDue);

export type PayableInvoice = {
  id: string;
  customerId: string;
  customerName: string;
  invoiceNumber: string;
  doctorName: string | null;
  patientName: string | null;
  issuedAt: string | null;
  dueAt: string | null;
  /** Due date, or invoice date when there is no due date (the A/R Aging rule). */
  agingDate: string | null;
  daysPastDue: number | null;
  bucket: AgingBucketKey;
  total: number;
  balance: number;
  partiallyPaid: boolean;
  /** On the customer's payable statement, so a statement payment may settle it. */
  onStatement: boolean;
  source: StatementInvoice;
};

export type PayableStatement = {
  /** The newest payable sent statement: the one a statement payment pays. */
  statementId: string;
  periodStart: string | null;
  periodEnd: string | null;
  sentAt: string | null;
  sentDates: string[];
  periods: Array<{ periodStart: string | null; periodEnd: string | null }>;
  /** Unpaid sent statements on the account. */
  statementCount: number;
  /** The newest statement's payable invoices; null when the server did not list them. */
  invoiceIds: string[] | null;
  /** What a statement payment settles today; null when an invoice balance is unknown. */
  balance: number | null;
  invoiceCount: number;
};

export type PayableCustomer = {
  /** Selection identity; doctor accounts use a practice-qualified synthetic id. */
  id: string;
  name: string;
  /** The organization row that owns this account; equal to `id` for practice accounts. */
  practiceOrganizationId?: string;
  practiceName?: string;
  doctorIdentity?: string | null;
  doctorDisplayName?: string | null;
  doctorLabelQualifier?: string;
  isDoctorAccount?: boolean;
  accountLabel?: string;
  initials: string;
  accountNumber: string | null;
  city: string | null;
  state: string | null;
  location: string | null;
  lastPaymentAt: string | null;
  lastPaymentAmount: number | null;
  doctorNames: string[];
  /** Outstanding invoices, oldest first. */
  invoices: PayableInvoice[];
  unpaidCount: number;
  /** Everything the customer owes today, statement or not. */
  totalBalance: number;
  statement: PayableStatement | null;
  oldest: PayableInvoice | null;
  overdue: boolean;
  partiallyPaid: boolean;
  /** The merged account the receiving step pays against. */
  account: EligibleAccount;
};

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const lettered = words.filter((word) => /^[A-Za-z]/.test(word));
  const letters = (lettered.length ? lettered : words)
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase());
  return letters.join("") || "?";
}

const AVATAR_COLORS = [
  "bg-sky-500",
  "bg-emerald-500",
  "bg-violet-500",
  "bg-amber-500",
  "bg-rose-500",
  "bg-teal-500",
  "bg-indigo-500",
  "bg-orange-500",
];

export function avatarColor(id: string): string {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]!;
}

export function plural(count: number, noun: string, pluralNoun = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : pluralNoun}`;
}

export function daysLabel(days: number): string {
  return plural(days, "day");
}

const agingTime = (invoice: PayableInvoice): number | null => {
  if (!invoice.agingDate) return null;
  const time = new Date(invoice.agingDate).getTime();
  return Number.isNaN(time) ? null : time;
};

/** Oldest first; invoices without any date last. */
function compareAging(a: PayableInvoice, b: PayableInvoice): number {
  const ta = agingTime(a);
  const tb = agingTime(b);
  if (ta !== tb) {
    if (ta === null) return 1;
    if (tb === null) return -1;
    return ta - tb;
  }
  return a.invoiceNumber.localeCompare(b.invoiceNumber, undefined, { numeric: true });
}

/** The most past-due invoice; ties go to the earliest date. */
export function oldestInvoice(invoices: readonly PayableInvoice[]): PayableInvoice | null {
  let oldest: PayableInvoice | null = null;
  for (const invoice of invoices) {
    if (!oldest) {
      oldest = invoice;
      continue;
    }
    const a = invoice.daysPastDue ?? Number.NEGATIVE_INFINITY;
    const b = oldest.daysPastDue ?? Number.NEGATIVE_INFINITY;
    if (a > b || (a === b && compareAging(invoice, oldest) < 0)) oldest = invoice;
  }
  return oldest;
}

/**
 * One row per customer with something payable: an unpaid sent statement, or
 * finalized open invoices. Invoice details come from the invoice-led list
 * when it has them, so the full outstanding set is visible even when a
 * statement covers part of the account.
 */
export function buildPayableCustomers(
  statementRows: readonly EligibleAccount[] | undefined,
  invoiceRows: readonly EligibleAccount[] | undefined,
  asOf: Date,
): PayableCustomer[] {
  const invoiceLed = new Map<string, EligibleAccount>();
  for (const row of Array.isArray(invoiceRows) ? invoiceRows : []) {
    invoiceLed.set(row.providerOrganizationId, row);
  }
  const statementLed = new Map<string, EligibleAccount>();
  for (const row of Array.isArray(statementRows) ? statementRows : []) {
    statementLed.set(row.providerOrganizationId, row);
  }
  const customers: PayableCustomer[] = [];
  for (const id of new Set([...invoiceLed.keys(), ...statementLed.keys()])) {
    const invoiceRow = invoiceLed.get(id);
    const statementRow = statementLed.get(id);
    const account: EligibleAccount = statementRow
      ? {
          ...statementRow,
          // Keep the complete outstanding-invoice set even when a statement
          // covers only part of the account.
          outstandingInvoices: invoiceRow?.outstandingInvoices ?? statementRow.outstandingInvoices,
          doctors: statementRow.doctors?.length ? statementRow.doctors : invoiceRow?.doctors,
          doctorProfiles: statementRow.doctorProfiles?.length
            ? statementRow.doctorProfiles
            : invoiceRow?.doctorProfiles,
        }
      : invoiceRow!;
    const name = account.providerName;

    const newest = statementRow?.statementId
      ? statementRow.statements?.find((row) => row.statementId === statementRow.statementId) ?? null
      : null;
    const statementInvoiceIds = newest?.invoiceIds ?? null;
    const onStatementIds = new Set(
      statementInvoiceIds ?? (statementRow?.outstandingInvoices ?? []).map((invoice) => invoice.id),
    );

    const invoices = (account.outstandingInvoices ?? [])
      .filter((invoice) => invoice.eligibleForPayment !== false)
      .map<PayableInvoice>((source) => {
        const agingDate = source.dueAt || source.issuedAt || null;
        const days = daysPastDue(agingDate, asOf);
        const total = amountOf(source.total || source.invoiceAmount);
        const balance = balanceOf(source);
        return {
          id: source.id,
          customerId: id,
          customerName: name,
          invoiceNumber: source.invoiceNumber,
          doctorName: source.doctorDisplayName || source.doctorName || source.doctor || null,
          patientName: source.patientName ?? null,
          issuedAt: source.issuedAt ?? null,
          dueAt: source.dueAt ?? null,
          agingDate,
          daysPastDue: days,
          bucket: agingBucket(days),
          total,
          balance,
          partiallyPaid: balance > 0.005 && total - balance > 0.005,
          onStatement: onStatementIds.has(source.id),
          source,
        };
      })
      .sort(compareAging);

    let statement: PayableStatement | null = null;
    if (statementRow?.statementId) {
      const lookup = new Map<string, StatementInvoice>();
      for (const invoice of statementRow.outstandingInvoices ?? []) lookup.set(invoice.id, invoice);
      for (const invoice of account.outstandingInvoices ?? []) lookup.set(invoice.id, invoice);
      let balance: number | null;
      let invoiceCount: number;
      if (statementInvoiceIds) {
        let sum = 0;
        let known = true;
        for (const invoiceId of statementInvoiceIds) {
          const invoice = lookup.get(invoiceId);
          if (!invoice) {
            known = false;
            break;
          }
          sum += balanceOf(invoice);
        }
        balance = known ? cents(sum) : null;
        invoiceCount = statementInvoiceIds.length;
      } else {
        balance = amountOf(statementRow.currentBalanceDue);
        invoiceCount = statementRow.invoiceCount;
      }
      statement = {
        statementId: statementRow.statementId,
        periodStart: statementRow.periodStart ?? null,
        periodEnd: statementRow.periodEnd ?? null,
        sentAt: statementRow.sentAt ?? null,
        sentDates: statementRow.sentDates?.length
          ? statementRow.sentDates
          : statementRow.sentAt
            ? [statementRow.sentAt]
            : [],
        periods: (statementRow.periods ?? []).map((period) => ({
          periodStart: period.periodStart ?? null,
          periodEnd: period.periodEnd ?? null,
        })),
        statementCount: statementRow.statementCount ?? 1,
        invoiceIds: statementInvoiceIds,
        balance,
        invoiceCount,
      };
    }

    const city = invoiceRow?.city ?? statementRow?.city ?? null;
    const state = invoiceRow?.state ?? statementRow?.state ?? null;
    const lastPaymentAmount = invoiceRow?.lastPaymentAmount ?? statementRow?.lastPaymentAmount ?? null;
    const doctorNames = [
      ...(account.doctorNames ?? []),
      ...(account.doctors ?? []).map((doctor) => doctor.doctorDisplayName),
      ...invoices.map((invoice) => invoice.doctorName ?? ""),
    ].filter(Boolean);
    const oldest = oldestInvoice(invoices);
    customers.push({
      id,
      name,
      initials: initials(name),
      accountNumber: invoiceRow?.accountNumber ?? statementRow?.accountNumber ?? null,
      city,
      state,
      location: [city, state].filter(Boolean).join(", ") || null,
      lastPaymentAt: invoiceRow?.lastPaymentAt ?? statementRow?.lastPaymentAt ?? null,
      lastPaymentAmount: lastPaymentAmount === null ? null : amountOf(lastPaymentAmount),
      doctorNames: [...new Set(doctorNames)],
      invoices,
      unpaidCount: account.outstandingInvoices ? invoices.length : account.invoiceCount,
      totalBalance: amountOf(invoiceRow?.currentBalanceDue ?? statementRow?.currentBalanceDue),
      statement,
      oldest,
      overdue: invoices.some((invoice) => (invoice.daysPastDue ?? 0) > 0),
      partiallyPaid: invoices.some((invoice) => invoice.partiallyPaid),
      account,
    });
  }
  return customers.sort((a, b) => a.name.localeCompare(b.name));
}

const doctorKey = (invoice: PayableInvoice): string | null => {
  const name = invoice.doctorName?.trim();
  if (!name) return null;
  return invoice.source.doctorIdentity?.trim() || name.trim().replace(/\s+/g, " ").toLocaleLowerCase();
};

/**
 * Creates selectable accounts for multi-doctor practices while keeping the
 * original practice account as the explicit whole-practice choice. Stable
 * profile IDs are preferred; legacy invoices use their normalized name key.
 */
export function buildSelectablePayableCustomers(
  practices: readonly PayableCustomer[],
): PayableCustomer[] {
  const result: PayableCustomer[] = [];
  for (const practice of practices) {
    const practiceId = practice.account.providerOrganizationId;
    const profilesById = new Map(
      (practice.account.doctorProfiles ?? []).map((profile) => [profile.id, profile]),
    );
    type DoctorAccount = {
      identity: string;
      invoices: PayableInvoice[];
      profile: NonNullable<EligibleAccount["doctorProfiles"]>[number] | undefined;
      displayName: string;
    };
    const byDoctor = new Map<string, DoctorAccount>();
    for (const invoice of practice.invoices) {
      const key = doctorKey(invoice);
      if (!key) continue;
      const profile = profilesById.get(key);
      const current: DoctorAccount = byDoctor.get(key) ?? {
        identity: key,
        invoices: [],
        profile,
        displayName: invoice.doctorName!,
      };
      current.invoices.push(invoice);
      byDoctor.set(key, current);
    }
    const doctorsByDisplayName = new Map<string, DoctorAccount[]>();
    for (const doctor of byDoctor.values()) {
      const displayKey = doctor.displayName.trim().replace(/\s+/g, " ").toLocaleLowerCase();
      const duplicates = doctorsByDisplayName.get(displayKey) ?? [];
      duplicates.push(doctor);
      doctorsByDisplayName.set(displayKey, duplicates);
    }
    const qualifiers = new Map<string, string>();
    for (const duplicates of doctorsByDisplayName.values()) {
      if (duplicates.length < 2) continue;
      const originalNames = duplicates.map((doctor) => doctor.profile?.doctorName?.trim() ?? "");
      const normalizedOriginalNames = originalNames.map((name) =>
        name.replace(/\s+/g, " ").toLocaleLowerCase(),
      );
      const allOriginalNamesDistinct =
        originalNames.every(Boolean) && new Set(normalizedOriginalNames).size === duplicates.length;
      for (const [index, doctor] of duplicates.entries()) {
        const qualifier = allOriginalNamesDistinct
          ? `Profile name: ${originalNames[index]}`
          : `Invoice${doctor.invoices.length === 1 ? "" : "s"}: ${doctor.invoices
              .slice(0, 2)
              .map((invoice) => invoice.invoiceNumber)
              .join(", ")}`;
        qualifiers.set(doctor.identity, qualifier);
      }
    }

    const practiceAccount = {
      ...practice,
      practiceOrganizationId: practiceId,
      practiceName: practice.name,
      accountLabel: byDoctor.size > 1 ? "Entire practice" : undefined,
    };
    result.push(practiceAccount);
    if (byDoctor.size < 2) continue;

    for (const [identity, doctor] of byDoctor) {
      const invoices = doctor.invoices;
      const balance = cents(invoices.reduce((sum, invoice) => sum + invoice.balance, 0));
      const oldest = oldestInvoice(invoices);
      const doctorLastPayment = practice.account.doctorLastPayments?.find(
        (payment) => payment.doctorIdentity === identity,
      );
      const labelQualifier = qualifiers.get(identity);
      const doctorLabel = labelQualifier
        ? `${doctor.displayName} (${labelQualifier})`
        : doctor.displayName;
      const doctorAccount: EligibleAccount = {
        ...practice.account,
        statementId: null,
        statementCount: 0,
        statements: [],
        outstandingInvoices: invoices.map((invoice) => invoice.source),
        invoiceCount: invoices.length,
        currentBalanceDue: balance.toFixed(2),
        lastPaymentAt: doctorLastPayment?.lastPaymentAt ?? null,
        lastPaymentAmount: doctorLastPayment?.lastPaymentAmount ?? null,
        doctors: [{ doctorIdentity: identity, doctorDisplayName: doctor.displayName }],
        doctorNames: [doctor.displayName],
        doctorLastPayments: doctorLastPayment ? [doctorLastPayment] : [],
      };
      result.push({
        ...practice,
        id: `doctor:${encodeURIComponent(practiceId)}:${encodeURIComponent(identity)}`,
        name: `${doctorLabel} · ${practice.name}`,
        practiceOrganizationId: practiceId,
        practiceName: practice.name,
        doctorIdentity: identity,
        doctorDisplayName: doctor.displayName,
        doctorLabelQualifier: labelQualifier,
        isDoctorAccount: true,
        accountLabel: labelQualifier ? undefined : doctor.displayName,
        initials: initials(doctor.displayName),
        doctorNames: [doctor.displayName],
        invoices,
        unpaidCount: invoices.length,
        totalBalance: balance,
        lastPaymentAt: doctorLastPayment?.lastPaymentAt ?? null,
        lastPaymentAmount: doctorLastPayment
          ? amountOf(doctorLastPayment.lastPaymentAmount)
          : null,
        statement: null,
        oldest,
        overdue: invoices.some((invoice) => (invoice.daysPastDue ?? 0) > 0),
        partiallyPaid: invoices.some((invoice) => invoice.partiallyPaid),
        account: doctorAccount,
      });
    }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Filters and sorting
// ---------------------------------------------------------------------------

export type StatusFilter = "" | "overdue" | "not_due" | "partial" | "statement" | "no_statement";

export const STATUS_FILTERS: ReadonlyArray<{ value: Exclude<StatusFilter, "">; label: string }> = [
  { value: "overdue", label: "Overdue" },
  { value: "not_due", label: "Not yet due" },
  { value: "partial", label: "Partially paid" },
  { value: "statement", label: "Statement sent" },
  { value: "no_statement", label: "No statement" },
];

/** Location filter value for customers with no city or state on file. */
export const NO_LOCATION = "__none__";

export type SelectionFilters = {
  search: string;
  status: StatusFilter;
  location: string;
  aging: AgingBucketKey | "";
};

export const EMPTY_FILTERS: SelectionFilters = { search: "", status: "", location: "", aging: "" };

export function filtersActive(filters: SelectionFilters): boolean {
  return !!(filters.search.trim() || filters.status || filters.location || filters.aging);
}

function matchesLocation(customer: PayableCustomer, location: string): boolean {
  if (!location) return true;
  if (location === NO_LOCATION) return !customer.location;
  return customer.location === location;
}

export function customerMatches(customer: PayableCustomer, filters: SelectionFilters): boolean {
  const query = filters.search.trim().toLowerCase();
  if (query) {
    const haystack = [
      customer.name,
      customer.accountNumber ?? "",
      ...customer.doctorNames,
      ...customer.invoices.map((invoice) => invoice.invoiceNumber),
    ]
      .join("\n")
      .toLowerCase();
    if (!haystack.includes(query)) return false;
  }
  switch (filters.status) {
    case "overdue":
      if (!customer.overdue) return false;
      break;
    case "not_due":
      if (customer.overdue) return false;
      break;
    case "partial":
      if (!customer.partiallyPaid) return false;
      break;
    case "statement":
      if (!customer.statement) return false;
      break;
    case "no_statement":
      if (customer.statement) return false;
      break;
  }
  if (!matchesLocation(customer, filters.location)) return false;
  if (filters.aging && agingBucket(customer.oldest?.daysPastDue ?? null) !== filters.aging) return false;
  return true;
}

export function invoiceMatches(
  invoice: PayableInvoice,
  customer: PayableCustomer,
  filters: SelectionFilters,
): boolean {
  const query = filters.search.trim().toLowerCase();
  if (query) {
    const haystack = [
      invoice.invoiceNumber,
      invoice.doctorName ?? "",
      invoice.patientName ?? "",
      customer.name,
      customer.accountNumber ?? "",
    ]
      .join("\n")
      .toLowerCase();
    if (!haystack.includes(query)) return false;
  }
  const overdue = (invoice.daysPastDue ?? 0) > 0;
  switch (filters.status) {
    case "overdue":
      if (!overdue) return false;
      break;
    case "not_due":
      if (overdue) return false;
      break;
    case "partial":
      if (!invoice.partiallyPaid) return false;
      break;
    case "statement":
      if (!invoice.onStatement) return false;
      break;
    case "no_statement":
      if (invoice.onStatement) return false;
      break;
  }
  if (!matchesLocation(customer, filters.location)) return false;
  if (filters.aging && invoice.bucket !== filters.aging) return false;
  return true;
}

export function locationOptions(customers: readonly PayableCustomer[]): {
  locations: string[];
  hasMissing: boolean;
} {
  const locations = new Set<string>();
  let hasMissing = false;
  for (const customer of customers) {
    if (customer.location) locations.add(customer.location);
    else hasMissing = true;
  }
  return { locations: [...locations].sort((a, b) => a.localeCompare(b)), hasMissing };
}

export type SortKey = "balance" | "name" | "oldest" | "invoices" | "lastPayment";
export type SortDirection = "asc" | "desc";
export type SortState = { key: SortKey; direction: SortDirection };

export const SORT_OPTIONS: ReadonlyArray<{ key: SortKey; label: string; defaultDirection: SortDirection }> = [
  { key: "balance", label: "Balance Due", defaultDirection: "desc" },
  { key: "name", label: "Name", defaultDirection: "asc" },
  { key: "oldest", label: "Oldest Invoice", defaultDirection: "asc" },
  { key: "invoices", label: "Unpaid Invoices", defaultDirection: "desc" },
  { key: "lastPayment", label: "Last Payment", defaultDirection: "desc" },
];

export const DEFAULT_SORT: SortState = { key: "balance", direction: "desc" };

/** Choosing a sort column: a new column starts in its natural direction; the same column flips. */
export function nextSort(current: SortState, key: SortKey): SortState {
  if (current.key === key) return { key, direction: current.direction === "asc" ? "desc" : "asc" };
  const option = SORT_OPTIONS.find((row) => row.key === key);
  return { key, direction: option?.defaultDirection ?? "asc" };
}

const timeOf = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
};

/** Compares two optional figures; missing figures always sort last. */
function compareFigures(a: number | null, b: number | null, direction: SortDirection): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return direction === "asc" ? a - b : b - a;
}

function customerSortFigure(customer: PayableCustomer, key: SortKey): number | null {
  switch (key) {
    case "balance":
      return customer.totalBalance;
    case "oldest":
      return customer.oldest ? agingTime(customer.oldest) : null;
    case "invoices":
      return customer.unpaidCount;
    case "lastPayment":
      return timeOf(customer.lastPaymentAt);
    default:
      return null;
  }
}

export function sortCustomers(customers: readonly PayableCustomer[], sort: SortState): PayableCustomer[] {
  return [...customers].sort((a, b) => {
    if (sort.key === "name") {
      const byName = a.name.localeCompare(b.name);
      return sort.direction === "asc" ? byName : -byName;
    }
    return (
      compareFigures(customerSortFigure(a, sort.key), customerSortFigure(b, sort.key), sort.direction) ||
      a.name.localeCompare(b.name)
    );
  });
}

/** The Statements tab sorts balance by the statement balance rather than everything owed. */
export function sortStatementCustomers(
  customers: readonly PayableCustomer[],
  sort: SortState,
): PayableCustomer[] {
  if (sort.key !== "balance") return sortCustomers(customers, sort);
  return [...customers].sort(
    (a, b) =>
      compareFigures(a.statement?.balance ?? null, b.statement?.balance ?? null, sort.direction) ||
      a.name.localeCompare(b.name),
  );
}

export function sortInvoices(
  invoices: readonly PayableInvoice[],
  sort: SortState,
  customers: ReadonlyMap<string, PayableCustomer>,
): PayableInvoice[] {
  return [...invoices].sort((a, b) => {
    let result = 0;
    switch (sort.key) {
      case "balance":
        result = compareFigures(a.balance, b.balance, sort.direction);
        break;
      case "name": {
        const byName = a.customerName.localeCompare(b.customerName);
        result = sort.direction === "asc" ? byName : -byName;
        break;
      }
      case "oldest":
        result = compareFigures(agingTime(a), agingTime(b), sort.direction);
        break;
      default: {
        const ca = customers.get(a.customerId);
        const cb = customers.get(b.customerId);
        result = compareFigures(
          ca ? customerSortFigure(ca, sort.key) : null,
          cb ? customerSortFigure(cb, sort.key) : null,
          sort.direction,
        );
        if (!result) result = a.customerName.localeCompare(b.customerName);
      }
    }
    return result || compareAging(a, b);
  });
}

// ---------------------------------------------------------------------------
// Selection and payment scope
// ---------------------------------------------------------------------------

export const EMPTY_SELECTION: Selection = { ids: [], scopes: {} };

/** A customer pays by statement when they have a payable sent statement. */
export function defaultScope(customer: PayableCustomer): CustomerScope {
  return { mode: customer.statement ? "statement" : "invoices", invoiceIds: null };
}

export function scopeFor(selection: Selection, customer: PayableCustomer): CustomerScope {
  return selection.scopes[customer.id] ?? defaultScope(customer);
}

/** Pays by statement: selected that way, or unselected with a payable statement. */
export function paysByStatement(selection: Selection, customer: PayableCustomer): boolean {
  return !!customer.statement && scopeFor(selection, customer).mode === "statement";
}

/** The invoices a scope covers; null when the statement's invoices are unknown. */
export function scopeInvoices(customer: PayableCustomer, scope: CustomerScope): PayableInvoice[] | null {
  if (scope.invoiceIds) {
    const ids = new Set(scope.invoiceIds);
    return customer.invoices.filter((invoice) => ids.has(invoice.id));
  }
  if (scope.mode === "statement" && customer.statement) {
    if (!customer.statement.invoiceIds) return null;
    const ids = new Set(customer.statement.invoiceIds);
    return customer.invoices.filter((invoice) => ids.has(invoice.id));
  }
  return customer.invoices;
}

export type ScopeFigures = {
  invoiceCount: number;
  /** Null when a balance in the scope is unknown. */
  amount: number | null;
  oldest: PayableInvoice | null;
};

export function scopeFigures(customer: PayableCustomer, scope: CustomerScope): ScopeFigures {
  if (scope.invoiceIds) {
    const invoices = scopeInvoices(customer, scope) ?? [];
    return {
      invoiceCount: invoices.length,
      amount: cents(invoices.reduce((sum, invoice) => sum + invoice.balance, 0)),
      oldest: oldestInvoice(invoices),
    };
  }
  if (scope.mode === "statement" && customer.statement) {
    const invoices = scopeInvoices(customer, scope);
    return {
      invoiceCount: customer.statement.invoiceCount,
      amount: customer.statement.balance,
      oldest: invoices ? oldestInvoice(invoices) : customer.oldest,
    };
  }
  return { invoiceCount: customer.unpaidCount, amount: customer.totalBalance, oldest: customer.oldest };
}

/** Per-customer figures as captured for the heads-up cards. */
export type CustomerFigures = ScopeFigures & { customerName: string };

export type SelectionTotals = {
  customers: number;
  invoices: number;
  /** Null when any selected amount is unknown. */
  amount: number | null;
  oldest: { invoice: PayableInvoice; customerName: string } | null;
};

export function selectionTotals(entries: readonly CustomerFigures[]): SelectionTotals {
  let invoices = 0;
  let amount: number | null = 0;
  let oldest: SelectionTotals["oldest"] = null;
  for (const entry of entries) {
    invoices += entry.invoiceCount;
    amount = amount === null || entry.amount === null ? null : amount + entry.amount;
    if (entry.oldest) {
      const candidate = oldestInvoice(oldest ? [oldest.invoice, entry.oldest] : [entry.oldest]);
      if (candidate === entry.oldest) oldest = { invoice: entry.oldest, customerName: entry.customerName };
    }
  }
  return {
    customers: entries.length,
    invoices,
    amount: amount === null ? null : cents(amount),
    oldest,
  };
}

export function selectedFigures(
  selection: Selection,
  customers: ReadonlyMap<string, PayableCustomer>,
): CustomerFigures[] {
  const figures: CustomerFigures[] = [];
  for (const id of selection.ids) {
    const customer = customers.get(id);
    if (!customer) continue;
    figures.push({ ...scopeFigures(customer, scopeFor(selection, customer)), customerName: customer.name });
  }
  return figures;
}

export function isSelected(selection: Selection, customerId: string): boolean {
  return selection.ids.includes(customerId);
}

export function doctorAccountsForPractice(
  customers: readonly PayableCustomer[],
  practice: PayableCustomer,
): PayableCustomer[] {
  const practiceId = practice.practiceOrganizationId ?? practice.account.providerOrganizationId;
  return customers.filter(
    (customer) =>
      customer.isDoctorAccount &&
      (customer.practiceOrganizationId ?? customer.account.providerOrganizationId) === practiceId,
  );
}

export function practiceDoctorSelectionState(
  selection: Selection,
  doctors: readonly PayableCustomer[],
): { checked: boolean; indeterminate: boolean } {
  const selected = doctors.filter((doctor) => isSelected(selection, doctor.id)).length;
  return {
    checked: doctors.length > 0 && selected === doctors.length,
    indeterminate: selected > 0 && selected < doctors.length,
  };
}

/** Parent controls select distinct doctor accounts, never the overlapping practice account. */
export function togglePracticeDoctorSelection(
  selection: Selection,
  practice: PayableCustomer,
  doctors: readonly PayableCustomer[],
): Selection {
  if (!doctors.length) return selection;
  const { checked } = practiceDoctorSelectionState(selection, doctors);
  const ids = doctors.map((doctor) => doctor.id);
  if (checked) return deselectCustomers(selection, [...ids, practice.id]);
  return selectCustomers(selection, doctors);
}

export function selectCustomers(
  selection: Selection,
  customers: readonly PayableCustomer[],
): Selection {
  const byPractice = new Map<string, PayableCustomer[]>();
  for (const customer of customers) {
    const practiceId = customer.practiceOrganizationId ?? customer.account.providerOrganizationId;
    const rows = byPractice.get(practiceId) ?? [];
    rows.push(customer);
    byPractice.set(practiceId, rows);
  }
  let ids = [...selection.ids];
  const scopes = { ...selection.scopes };
  for (const [practiceId, requested] of byPractice) {
    const selectedRows = requested.some((customer) => !customer.isDoctorAccount)
      ? requested.filter((customer) => !customer.isDoctorAccount).slice(0, 1)
      : requested.filter((customer) => customer.isDoctorAccount);
    const incomingIds = new Set(selectedRows.map((customer) => customer.id));
    const hasPracticeSelection = selectedRows.some((customer) => !customer.isDoctorAccount);
    const remove = ids.filter((id) => {
      const existingPracticeId = selectionPracticeId(id);
      return existingPracticeId === practiceId &&
        (hasPracticeSelection ? id !== practiceId : id === practiceId);
    });
    ids = ids.filter((id) => !remove.includes(id));
    for (const id of remove) delete scopes[id];
    for (const customer of selectedRows) {
      if (!ids.includes(customer.id) && incomingIds.has(customer.id)) {
        ids.push(customer.id);
        scopes[customer.id] = defaultScope(customer);
      }
    }
  }
  return ids.length === selection.ids.length &&
    ids.every((id, index) => id === selection.ids[index]) &&
    Object.keys(scopes).length === Object.keys(selection.scopes).length
    ? selection
    : { ids, scopes };
}

function selectionPracticeId(id: string): string {
  if (!id.startsWith("doctor:")) return id;
  const encodedPracticeId = id.slice("doctor:".length).split(":")[0]!;
  try {
    return decodeURIComponent(encodedPracticeId);
  } catch {
    return encodedPracticeId;
  }
}

function withoutOverlappingSelection(
  selection: Selection,
  customer: PayableCustomer,
): Selection {
  const practiceId = customer.practiceOrganizationId ?? customer.account.providerOrganizationId;
  const remove = selection.ids.filter((id) =>
    selectionPracticeId(id) === practiceId &&
    (customer.isDoctorAccount ? id === practiceId : id !== customer.id),
  );
  if (!remove.length) return selection;
  return deselectCustomers(selection, remove);
}

export function deselectCustomers(selection: Selection, ids: readonly string[]): Selection {
  const removing = new Set(ids.filter((id) => selection.ids.includes(id)));
  if (!removing.size) return selection;
  const scopes = { ...selection.scopes };
  for (const id of removing) delete scopes[id];
  return { ids: selection.ids.filter((id) => !removing.has(id)), scopes };
}

/** Pay this customer's payable statement in full. */
export function selectStatementScope(selection: Selection, customer: PayableCustomer): Selection {
  if (!customer.statement) return selectCustomers(selection, [customer]);
  const scope: CustomerScope = { mode: "statement", invoiceIds: null };
  const nonOverlapping = withoutOverlappingSelection(selection, customer);
  return {
    ids: nonOverlapping.ids.includes(customer.id) ? nonOverlapping.ids : [...nonOverlapping.ids, customer.id],
    scopes: { ...nonOverlapping.scopes, [customer.id]: scope },
  };
}

export function isInvoicePicked(
  selection: Selection,
  customer: PayableCustomer,
  invoice: PayableInvoice,
): boolean {
  const scope = selection.scopes[customer.id];
  if (!scope) return false;
  if (scope.invoiceIds) return scope.invoiceIds.includes(invoice.id);
  return scope.mode === "statement" && customer.statement ? invoice.onStatement : true;
}

function coveredInvoiceIds(customer: PayableCustomer, scope: CustomerScope): string[] {
  if (scope.invoiceIds) return scope.invoiceIds;
  if (scope.mode === "statement" && customer.statement) {
    return customer.invoices.filter((invoice) => invoice.onStatement).map((invoice) => invoice.id);
  }
  return customer.invoices.map((invoice) => invoice.id);
}

const sameIds = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id) => b.includes(id));

/**
 * The scope that pays exactly the `chosen` outstanding invoices: the
 * statement when the customer prefers paying by statement and every choice
 * is on it, otherwise those invoices directly (noting the switch when a
 * choice is not on the statement). Null when nothing chosen is outstanding.
 */
function scopeForPicks(
  customer: PayableCustomer,
  chosen: ReadonlySet<string>,
  statementPreferred: boolean,
): CustomerScope | null {
  const ordered = customer.invoices.map((invoice) => invoice.id).filter((id) => chosen.has(id));
  if (!ordered.length) return null;
  const offStatement = customer.invoices.find(
    (invoice) => chosen.has(invoice.id) && !invoice.onStatement,
  );
  if (statementPreferred && customer.statement && !offStatement) {
    const statementIds = customer.invoices.filter((invoice) => invoice.onStatement).map((invoice) => invoice.id);
    return { mode: "statement", invoiceIds: sameIds(ordered, statementIds) ? null : ordered };
  }
  const allIds = customer.invoices.map((invoice) => invoice.id);
  const switched = statementPreferred && !!customer.statement;
  return {
    mode: "invoices",
    invoiceIds: sameIds(ordered, allIds) ? null : ordered,
    ...(switched ? { switchedFromStatement: true, switchedBy: offStatement?.invoiceNumber } : {}),
  };
}

/**
 * Picks or unpicks a customer's invoices. Picking limits the customer's
 * payment to the picked invoices; a pick that is not on the customer's
 * statement switches them to paying invoices directly. Unpicking the last
 * invoice deselects the customer.
 */
export function pickInvoices(
  selection: Selection,
  customer: PayableCustomer,
  invoiceIds: readonly string[],
  picked: boolean,
): Selection {
  const nonOverlapping = withoutOverlappingSelection(selection, customer);
  const existing = nonOverlapping.scopes[customer.id];
  const chosen = new Set(existing ? coveredInvoiceIds(customer, existing) : []);
  for (const id of invoiceIds) {
    if (picked) chosen.add(id);
    else chosen.delete(id);
  }
  const statementPreferred = existing
    ? existing.mode === "statement" || !!existing.switchedFromStatement
    : !!customer.statement;
  const scope = scopeForPicks(customer, chosen, statementPreferred);
  if (!scope) return deselectCustomers(nonOverlapping, [customer.id]);
  return {
    ids: nonOverlapping.ids.includes(customer.id) ? nonOverlapping.ids : [...nonOverlapping.ids, customer.id],
    scopes: { ...nonOverlapping.scopes, [customer.id]: scope },
  };
}

/**
 * Drops customers that no longer have anything payable and picks that are
 * no longer outstanding. A customer paying a statement that is no longer
 * payable is dropped rather than widened to everything they owe; picked
 * invoices are then paid directly. Returns the same object when nothing
 * changed so React effects can prune without looping.
 */
export function pruneSelection(
  selection: Selection,
  customers: ReadonlyMap<string, PayableCustomer>,
): Selection {
  let changed = false;
  const ids: string[] = [];
  const scopes: Record<string, CustomerScope> = {};
  for (const id of selection.ids) {
    const customer = customers.get(id);
    const scope = selection.scopes[id];
    if (!customer || !scope) {
      changed = true;
      continue;
    }
    let next = scope;
    if (!customer.statement && (next.mode === "statement" || next.switchedFromStatement)) {
      if (next.mode === "statement" && !next.invoiceIds) {
        changed = true;
        continue;
      }
      next = { mode: "invoices", invoiceIds: next.invoiceIds };
    }
    if (next.invoiceIds) {
      const live = next.invoiceIds.filter((invoiceId) =>
        customer.invoices.some((invoice) => invoice.id === invoiceId),
      );
      if (!live.length) {
        changed = true;
        continue;
      }
      if (live.length !== next.invoiceIds.length) next = { ...next, invoiceIds: live };
      if (next.mode === "statement") {
        const off = customer.invoices.find(
          (invoice) => live.includes(invoice.id) && !invoice.onStatement,
        );
        if (off) {
          next = {
            mode: "invoices",
            invoiceIds: next.invoiceIds,
            switchedFromStatement: true,
            switchedBy: off.invoiceNumber,
          };
        }
      }
    }
    if (next !== scope) changed = true;
    ids.push(id);
    scopes[id] = next;
  }
  return changed ? { ids, scopes } : selection;
}

// ---------------------------------------------------------------------------
// Aging groups
// ---------------------------------------------------------------------------

export type AgingGroupRow = {
  customer: PayableCustomer;
  invoiceCount: number;
  balance: number;
};

export type AgingGroup = {
  key: AgingBucketKey;
  label: string;
  rows: AgingGroupRow[];
  total: number;
};

/**
 * Customers grouped by the A/R Aging buckets their invoices fall in, with
 * bucket totals. Rows keep the order of `customers`.
 */
export function agingGroups(customers: readonly PayableCustomer[]): AgingGroup[] {
  return AGING_BUCKETS.map(({ key, label }) => {
    const rows: AgingGroupRow[] = [];
    for (const customer of customers) {
      if (!customer.invoices.length) {
        // Invoice details are unavailable; age the whole balance as current.
        if (key === AgingBucketKey.current && customer.totalBalance > 0) {
          rows.push({ customer, invoiceCount: customer.unpaidCount, balance: customer.totalBalance });
        }
        continue;
      }
      const invoices = customer.invoices.filter((invoice) => invoice.bucket === key);
      if (!invoices.length) continue;
      rows.push({
        customer,
        invoiceCount: invoices.length,
        balance: cents(invoices.reduce((sum, invoice) => sum + invoice.balance, 0)),
      });
    }
    return { key, label, rows, total: cents(rows.reduce((sum, row) => sum + row.balance, 0)) };
  });
}

// ---------------------------------------------------------------------------
// Saved selections (this computer only)
// ---------------------------------------------------------------------------

export const SAVED_SELECTIONS_PREFIX = "labtrax_receive_payment_selections_v1";

export function savedSelectionsKey(userId: string, labId: string): string {
  return `${SAVED_SELECTIONS_PREFIX}:${userId}:${labId}`;
}

function isSavedScope(value: unknown): value is CustomerScope {
  if (!value || typeof value !== "object") return false;
  const scope = value as Partial<CustomerScope>;
  return (
    (scope.mode === "statement" || scope.mode === "invoices") &&
    (scope.invoiceIds === null ||
      (Array.isArray(scope.invoiceIds) && scope.invoiceIds.every((id) => typeof id === "string"))) &&
    (scope.switchedFromStatement === undefined || typeof scope.switchedFromStatement === "boolean") &&
    (scope.switchedBy === undefined || typeof scope.switchedBy === "string")
  );
}

/** A malformed customer or scope rejects the whole set; a missing scope is allowed. */
function isSavedSelection(value: unknown): value is SavedSelection {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<SavedSelection>;
  return (
    typeof row.name === "string" &&
    typeof row.savedAt === "string" &&
    Array.isArray(row.customers) &&
    row.customers.every(
      (customer) =>
        !!customer &&
        typeof customer.id === "string" &&
        typeof customer.name === "string" &&
        (customer.scope === undefined || isSavedScope(customer.scope)),
    )
  );
}

export function readSavedSelections(storage: Storage | null | undefined, key: string): SavedSelection[] {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isSavedSelection) : [];
  } catch {
    return [];
  }
}

export function writeSavedSelections(
  storage: Storage | null | undefined,
  key: string,
  selections: readonly SavedSelection[],
): boolean {
  try {
    if (!storage) return false;
    if (selections.length) storage.setItem(key, JSON.stringify(selections));
    else storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/** Adds a named set, replacing one with the same name; newest first. */
export function upsertSavedSelection(
  selections: readonly SavedSelection[],
  entry: SavedSelection,
): SavedSelection[] {
  const name = entry.name.trim().toLowerCase();
  return [entry, ...selections.filter((row) => row.name.trim().toLowerCase() !== name)];
}

/** The selection a saved set stores: every selected customer with their payment scope. */
export function savedSelectionCustomers(
  selection: Selection,
  customers: ReadonlyMap<string, PayableCustomer>,
): SavedSelection["customers"] {
  return selection.ids.map((id) => {
    const customer = customers.get(id);
    return {
      id,
      name: customer?.name ?? id,
      scope: selection.scopes[id] ?? (customer ? defaultScope(customer) : { mode: "invoices", invoiceIds: null }),
    };
  });
}

type NamedCustomer = { id: string; name: string };

export type RestoredSelection = {
  selection: Selection;
  /** Selected with fewer picked invoices than were saved: the rest are no longer outstanding. */
  narrowed: NamedCustomer[];
  /** Still payable, but left unselected because their saved scope no longer applies. */
  unselected: Array<NamedCustomer & { reason: "statement" | "invoices" }>;
  /** Nothing payable now. */
  missing: NamedCustomer[];
};

/**
 * Re-selects a saved set against the customers payable now, in the saved
 * order. Each saved scope is restored when it still applies; picked invoices
 * are narrowed to the ones still outstanding. A scope is never widened: a
 * customer whose statement is no longer payable, or whose picked invoices
 * are all paid, stays unselected and is named. Customers saved without a
 * scope load with their default scope.
 */
export function restoreSavedSelection(
  saved: SavedSelection,
  customers: ReadonlyMap<string, PayableCustomer>,
): RestoredSelection {
  const ids: string[] = [];
  const scopes: Record<string, CustomerScope> = {};
  const narrowed: NamedCustomer[] = [];
  const unselected: RestoredSelection["unselected"] = [];
  const missing: NamedCustomer[] = [];
  const seen = new Set<string>();
  for (const entry of saved.customers) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    const customer = customers.get(entry.id);
    if (!customer) {
      missing.push({ id: entry.id, name: entry.name });
      continue;
    }
    const named = { id: customer.id, name: customer.name };
    const savedScope = entry.scope;
    let scope: CustomerScope | null;
    if (!savedScope) {
      scope = defaultScope(customer);
    } else if (savedScope.invoiceIds) {
      const picks = new Set(savedScope.invoiceIds);
      const live = new Set(customer.invoices.filter((invoice) => picks.has(invoice.id)).map((invoice) => invoice.id));
      scope = scopeForPicks(customer, live, savedScope.mode === "statement" || !!savedScope.switchedFromStatement);
      if (!scope) {
        unselected.push({ ...named, reason: "invoices" });
        continue;
      }
      if (live.size < picks.size) narrowed.push(named);
    } else if (savedScope.mode === "statement") {
      if (!customer.statement) {
        unselected.push({ ...named, reason: "statement" });
        continue;
      }
      scope = { mode: "statement", invoiceIds: null };
    } else if (savedScope.switchedFromStatement) {
      // Every outstanding invoice, paid directly instead of by statement.
      scope =
        scopeForPicks(customer, new Set(customer.invoices.map((invoice) => invoice.id)), true) ??
        { mode: "invoices", invoiceIds: null };
    } else {
      scope = { mode: "invoices", invoiceIds: null };
    }
    const doctors = customer.isDoctorAccount ? [] : doctorAccountsForPractice([...customers.values()], customer);
    if (doctors.length) {
      // Older saved sets may contain the former practice-wide account. Expand
      // its saved invoice scope into the matching doctor accounts so loading
      // that set cannot silently create an overlapping practice payment.
      const covered = new Set(coveredInvoiceIds(customer, scope));
      for (const doctor of doctors) {
        const doctorInvoiceIds = doctor.invoices
          .filter((invoice) => covered.has(invoice.id))
          .map((invoice) => invoice.id);
        const doctorScope = scopeForPicks(doctor, new Set(doctorInvoiceIds), false);
        if (!doctorScope) continue;
        if (!ids.includes(doctor.id)) ids.push(doctor.id);
        scopes[doctor.id] = doctorScope;
      }
      continue;
    }
    if (!ids.includes(customer.id)) ids.push(customer.id);
    scopes[customer.id] = scope;
  }
  const wholePracticeIds = new Set(
    ids.filter((id) => {
      const customer = customers.get(id);
      return !!customer && !customer.isDoctorAccount;
    }),
  );
  const wholePracticeOrganizations = new Set(
    [...wholePracticeIds].map((id) => {
      const customer = customers.get(id)!;
      return customer.practiceOrganizationId ?? customer.account.providerOrganizationId;
    }),
  );
  const compatibleIds = ids.filter((id) => {
    const customer = customers.get(id)!;
    return !customer.isDoctorAccount ||
      !wholePracticeOrganizations.has(customer.practiceOrganizationId ?? customer.account.providerOrganizationId);
  });
  const compatibleScopes = Object.fromEntries(compatibleIds.map((id) => [id, scopes[id]!]));
  return { selection: { ids: compatibleIds, scopes: compatibleScopes }, narrowed, unselected, missing };
}
