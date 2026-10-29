import { describe, expect, it } from "vitest";
import { AgingBucketKey } from "@/lib/ap-types";
import {
  agingAsOf,
  agingBucket,
  agingGroups,
  buildPayableCustomers,
  buildSelectablePayableCustomers,
  customerMatches,
  daysPastDue,
  deselectCustomers,
  doctorAccountsForPractice,
  EMPTY_FILTERS,
  EMPTY_SELECTION,
  filtersActive,
  invoiceMatches,
  isInvoicePicked,
  locationOptions,
  nextSort,
  NO_LOCATION,
  pickInvoices,
  pruneSelection,
  practiceDoctorSelectionState,
  readSavedSelections,
  restoreSavedSelection,
  savedSelectionCustomers,
  savedSelectionsKey,
  scopeFigures,
  scopeFor,
  selectCustomers,
  togglePracticeDoctorSelection,
  selectedFigures,
  selectionTotals,
  selectStatementScope,
  sortCustomers,
  upsertSavedSelection,
  writeSavedSelections,
  type PayableCustomer,
  type SelectionFilters,
} from "../model";
import { allocateOldestFirst, batchDraft, draftWithDefaults, localCalendarDate } from "../payments";
import type {
  CustomerScope,
  EligibleAccount,
  PaymentDefaults,
  SavedSelection,
  Selection,
  StatementInvoice,
} from "../types";

// Aging is measured to the end of the local calendar day, as the A/R Aging
// report measures "as of today". Dates below are local midnights.
const asOf = new Date(2026, 5, 30, 23, 59, 59, 999);
const day = (date: string) => `${date}T00:00:00`;

function invoice(
  id: string,
  invoiceNumber: string,
  fields: { due?: string; issued?: string; total: string; balance: string; doctor?: string; patient?: string },
): StatementInvoice {
  return {
    id,
    invoiceNumber,
    ...(fields.due ? { dueAt: day(fields.due) } : {}),
    ...(fields.issued ? { issuedAt: day(fields.issued) } : {}),
    total: fields.total,
    currentBalanceDue: fields.balance,
    doctorName: fields.doctor ?? null,
    patientName: fields.patient ?? null,
    eligibleForPayment: true,
  };
}

const a1 = invoice("a1", "INV-1001", { due: "2026-05-01", issued: "2026-04-01", total: "100.00", balance: "100.00", doctor: "Dr. Ada Smith", patient: "Pat Jones" });
// Partially paid: 30 of 80 already received.
const a2 = invoice("a2", "INV-1002", { due: "2026-06-10", issued: "2026-05-11", total: "80.00", balance: "50.00", doctor: "Dr. Ada Smith" });
// Not on Alpha's statement and not yet due.
const a3 = invoice("a3", "INV-1003", { due: "2026-07-20", issued: "2026-06-20", total: "50.00", balance: "50.00", doctor: "Dr. Ada Smith" });
const b1 = invoice("b1", "INV-2001", { due: "2026-03-01", total: "300.00", balance: "300.00", doctor: "Dr. Ben Ortiz" });
const g1 = invoice("g1", "INV-3001", { due: "2026-07-15", total: "50.00", balance: "50.00", doctor: "Dr. Grace Hopper" });
// No due date and no invoice date: it cannot be aged, so it counts as current.
const g2 = invoice("g2", "INV-3002", { total: "30.00", balance: "30.00", doctor: "Dr. Grace Hopper" });

const alphaStatementRow: EligibleAccount = {
  providerOrganizationId: "alpha",
  providerName: "Alpha Dental",
  statementId: "st-a2",
  periodStart: "2026-05-01",
  periodEnd: "2026-05-31",
  sentAt: "2026-06-01T15:00:00.000Z",
  sentDates: ["2026-06-01T15:00:00.000Z", "2026-06-15T15:00:00.000Z"],
  periods: [
    { periodStart: "2026-05-01", periodEnd: "2026-05-31" },
    { periodStart: "2026-04-01", periodEnd: "2026-04-30" },
  ],
  statementCount: 2,
  invoiceCount: 2,
  currentBalanceDue: "150.00",
  statements: [
    { statementId: "st-a2", sentAt: "2026-06-01T15:00:00.000Z", periodStart: "2026-05-01", periodEnd: "2026-05-31", invoiceCount: 2, invoiceIds: ["a1", "a2"] },
    { statementId: "st-a1", sentAt: "2026-05-01T15:00:00.000Z", periodStart: "2026-04-01", periodEnd: "2026-04-30", invoiceCount: 1, invoiceIds: ["a1"] },
  ],
  outstandingInvoices: [a1, a2],
  doctorNames: ["Dr. Ada Smith"],
  accountNumber: "LT-1001",
  city: "Austin",
  state: "TX",
  lastPaymentAt: "2026-06-15T15:00:00.000Z",
  lastPaymentAmount: "75.00",
};
const invoiceRows: EligibleAccount[] = [
  {
    providerOrganizationId: "alpha",
    providerName: "Alpha Dental",
    invoiceCount: 3,
    currentBalanceDue: "200.00",
    outstandingInvoices: [a3, a1, a2],
    doctorNames: ["Dr. Ada Smith"],
    accountNumber: "LT-1001",
    city: "Austin",
    state: "TX",
    lastPaymentAt: "2026-06-15T15:00:00.000Z",
    lastPaymentAmount: "75.00",
  },
  {
    providerOrganizationId: "beta",
    providerName: "Beta Smiles",
    invoiceCount: 1,
    currentBalanceDue: "300.00",
    outstandingInvoices: [b1],
    doctorNames: ["Dr. Ben Ortiz"],
    accountNumber: null,
    city: "Dallas",
    state: "TX",
    lastPaymentAt: null,
    lastPaymentAmount: null,
  },
  {
    providerOrganizationId: "gamma",
    providerName: "Gamma Lab Partners",
    invoiceCount: 2,
    currentBalanceDue: "80.00",
    outstandingInvoices: [g2, g1],
    doctorNames: ["Dr. Grace Hopper"],
    accountNumber: "LT-1003",
    city: null,
    state: null,
    lastPaymentAt: "2026-05-20T15:00:00.000Z",
    lastPaymentAmount: "40.00",
  },
];

function fixture() {
  const customers = buildPayableCustomers([alphaStatementRow], invoiceRows, asOf);
  const byId = new Map(customers.map((customer) => [customer.id, customer]));
  const get = (id: string): PayableCustomer => {
    const customer = byId.get(id);
    if (!customer) throw new Error(`missing customer ${id}`);
    return customer;
  };
  return { customers, byId, alpha: get("alpha"), beta: get("beta"), gamma: get("gamma") };
}

const names = (customers: readonly PayableCustomer[]) => customers.map((customer) => customer.name);
const filtered = (customers: readonly PayableCustomer[], filters: Partial<SelectionFilters>) =>
  names(customers.filter((customer) => customerMatches(customer, { ...EMPTY_FILTERS, ...filters })));

describe("days past due (the A/R Aging report's rule)", () => {
  it("counts whole days from the due date to the end of today", () => {
    expect(daysPastDue(day("2026-06-30"), asOf)).toBe(0);
    expect(daysPastDue(day("2026-06-29"), asOf)).toBe(1);
    expect(daysPastDue(day("2026-05-31"), asOf)).toBe(30);
    expect(daysPastDue(day("2026-05-30"), asOf)).toBe(31);
    expect(daysPastDue(day("2026-05-01"), asOf)).toBe(60);
    expect(daysPastDue(day("2026-04-30"), asOf)).toBe(61);
    expect(daysPastDue(day("2026-04-01"), asOf)).toBe(90);
    expect(daysPastDue(day("2026-03-31"), asOf)).toBe(91);
    expect(daysPastDue(day("2026-07-15"), asOf)).toBeLessThan(0);
    expect(daysPastDue(null, asOf)).toBeNull();
    expect(daysPastDue("not a date", asOf)).toBeNull();
  });

  it("measures today to the end of the local calendar day", () => {
    expect(agingAsOf(new Date(2026, 5, 30, 8, 15)).getTime()).toBe(asOf.getTime());
  });

  it("places figures in the report's buckets, with due today and undated invoices current", () => {
    expect(agingBucket(null)).toBe(AgingBucketKey.current);
    expect(agingBucket(-3)).toBe(AgingBucketKey.current);
    expect(agingBucket(0)).toBe(AgingBucketKey.current);
    expect(agingBucket(1)).toBe(AgingBucketKey.d1_30);
    expect(agingBucket(30)).toBe(AgingBucketKey.d1_30);
    expect(agingBucket(31)).toBe(AgingBucketKey.d31_60);
    expect(agingBucket(60)).toBe(AgingBucketKey.d31_60);
    expect(agingBucket(61)).toBe(AgingBucketKey.d61_90);
    expect(agingBucket(90)).toBe(AgingBucketKey.d61_90);
    expect(agingBucket(91)).toBe(AgingBucketKey.d90_plus);
  });

  it("ages by the due date, or by the invoice date when there is no due date", () => {
    const [customer] = buildPayableCustomers(
      [],
      [
        {
          providerOrganizationId: "z",
          providerName: "Zed Dental",
          invoiceCount: 2,
          currentBalanceDue: "30.00",
          outstandingInvoices: [
            invoice("z1", "Z-1", { issued: "2026-06-20", total: "10.00", balance: "10.00" }),
            invoice("z2", "Z-2", { issued: "2026-03-01", due: "2026-06-25", total: "20.00", balance: "20.00" }),
          ],
        },
      ],
      asOf,
    );
    const byNumber = new Map(customer!.invoices.map((row) => [row.invoiceNumber, row]));
    expect(byNumber.get("Z-1")).toMatchObject({ agingDate: day("2026-06-20"), daysPastDue: 10, bucket: AgingBucketKey.d1_30 });
    expect(byNumber.get("Z-2")).toMatchObject({ agingDate: day("2026-06-25"), daysPastDue: 5, bucket: AgingBucketKey.d1_30 });
  });
});

describe("payable customer rows", () => {
  it("merges the statement and invoice lists into one row per customer, sorted by name", () => {
    const { customers, alpha } = fixture();
    expect(names(customers)).toEqual(["Alpha Dental", "Beta Smiles", "Gamma Lab Partners"]);
    // The full outstanding set is listed, oldest first, even though the
    // statement covers only part of it.
    expect(alpha.invoices.map((row) => [row.id, row.onStatement])).toEqual([
      ["a1", true],
      ["a2", true],
      ["a3", false],
    ]);
    expect(alpha).toMatchObject({
      initials: "AD",
      accountNumber: "LT-1001",
      location: "Austin, TX",
      lastPaymentAt: "2026-06-15T15:00:00.000Z",
      lastPaymentAmount: 75,
      unpaidCount: 3,
      totalBalance: 200,
      overdue: true,
      partiallyPaid: true,
    });
    expect(alpha.oldest?.id).toBe("a1");
    expect(alpha.oldest?.daysPastDue).toBe(60);
    expect(alpha.statement).toMatchObject({
      statementId: "st-a2",
      statementCount: 2,
      invoiceIds: ["a1", "a2"],
      invoiceCount: 2,
      balance: 150,
    });
    expect(alpha.statement?.sentDates).toHaveLength(2);
  });

  it("uses the statement balance when the server does not list the statement's invoices", () => {
    const [legacy] = buildPayableCustomers(
      [
        {
          providerOrganizationId: "delta",
          providerName: "Delta Ortho",
          statementId: "st-d",
          invoiceCount: 4,
          currentBalanceDue: "500.00",
          statements: [{ statementId: "st-d", sentAt: "2026-06-01", periodStart: null, periodEnd: "2026-05-31", invoiceCount: 4 }],
        },
      ],
      [],
      asOf,
    );
    expect(legacy).toMatchObject({ invoices: [], unpaidCount: 4, totalBalance: 500, oldest: null, location: null });
    expect(legacy!.statement).toMatchObject({ invoiceIds: null, balance: 500, invoiceCount: 4 });
  });

  it("reports an unknown statement balance instead of a partial sum", () => {
    const e1 = invoice("e1", "INV-5001", { due: "2026-06-01", total: "40.00", balance: "40.00" });
    const [customer] = buildPayableCustomers(
      [
        {
          providerOrganizationId: "eps",
          providerName: "Epsilon Dental",
          statementId: "st-e",
          invoiceCount: 2,
          currentBalanceDue: "90.00",
          statements: [{ statementId: "st-e", sentAt: "2026-06-01", periodStart: null, periodEnd: "2026-05-31", invoiceCount: 2, invoiceIds: ["e1", "e-gone"] }],
          outstandingInvoices: [e1],
        },
      ],
      [{ providerOrganizationId: "eps", providerName: "Epsilon Dental", invoiceCount: 1, currentBalanceDue: "40.00", outstandingInvoices: [e1] }],
      asOf,
    );
    expect(customer!.statement?.balance).toBeNull();
    expect(customer!.totalBalance).toBe(40);
  });
});

describe("doctor payment accounts", () => {
  it("creates separate doctor accounts alongside the whole-practice account", () => {
    const adaInvoice = { ...invoice("multi-a", "M-1", { total: "40.00", balance: "30.00", doctor: "Dr. Ada" }), doctorIdentity: "profile-ada" };
    const benInvoice = { ...invoice("multi-b", "M-2", { total: "25.00", balance: "25.00", doctor: "Dr. Ben" }), doctorIdentity: "profile-ben" };
    const [practice] = buildPayableCustomers([], [{
      providerOrganizationId: "multi",
      providerName: "Multi Dental",
      invoiceCount: 2,
      currentBalanceDue: "55.00",
      lastPaymentAt: "2026-10-01T12:00:00.000Z",
      lastPaymentAmount: "35.00",
      doctorLastPayments: [
        {
          doctorIdentity: "profile-ada",
          lastPaymentAt: "2026-09-20T12:00:00.000Z",
          lastPaymentAmount: "20.00",
        },
      ],
      outstandingInvoices: [adaInvoice, benInvoice],
    }], asOf);
    const accounts = buildSelectablePayableCustomers([practice!]);
    const whole = accounts.find((account) => !account.isDoctorAccount)!;
    const ada = accounts.find((account) => account.doctorIdentity === "profile-ada")!;
    const ben = accounts.find((account) => account.doctorIdentity === "profile-ben")!;

    expect(accounts).toHaveLength(3);
    expect(whole.accountLabel).toBe("Entire practice");
    expect(whole.lastPaymentAmount).toBe(35);
    expect(ada).toMatchObject({
      practiceOrganizationId: "multi",
      practiceName: "Multi Dental",
      doctorDisplayName: "Dr. Ada",
      totalBalance: 30,
      unpaidCount: 1,
      lastPaymentAt: "2026-09-20T12:00:00.000Z",
      lastPaymentAmount: 20,
      statement: null,
    });
    expect(ada.invoices.map((row) => row.id)).toEqual(["multi-a"]);
    expect(ada.account.providerOrganizationId).toBe("multi");
    expect(ada.account).toMatchObject({
      lastPaymentAt: "2026-09-20T12:00:00.000Z",
      lastPaymentAmount: "20.00",
    });
    expect(ben).toMatchObject({ lastPaymentAt: null, lastPaymentAmount: null });
    expect(ben.account).toMatchObject({
      lastPaymentAt: null,
      lastPaymentAmount: null,
    });

    const byId = new Map(accounts.map((account) => [account.id, account]));
    let selection = selectCustomers(EMPTY_SELECTION, [ada, ben]);
    expect(selection.ids).toEqual([ada.id, ben.id]);
    expect(selectionTotals(selectedFigures(selection, byId))).toMatchObject({
      customers: 2,
      invoices: 2,
      amount: 55,
    });
    const saved = {
      name: "Two doctors",
      savedAt: "2026-10-25T12:00:00.000Z",
      customers: savedSelectionCustomers(selection, byId),
    };
    expect(restoreSavedSelection(saved, byId).selection.ids).toEqual([ada.id, ben.id]);
    selection = selectCustomers(selection, [whole]);
    expect(selection.ids).toEqual([whole.id]);
    selection = selectCustomers(selection, [ada]);
    expect(selection.ids).toEqual([ada.id]);

    const doctors = doctorAccountsForPractice(accounts, whole);
    expect(doctors.map((doctor) => doctor.id)).toEqual([ada.id, ben.id]);
    const parentSelected = togglePracticeDoctorSelection(EMPTY_SELECTION, whole, doctors);
    expect(parentSelected.ids).toEqual([ada.id, ben.id]);
    expect(parentSelected.ids).not.toContain(whole.id);
    expect(practiceDoctorSelectionState(parentSelected, doctors)).toEqual({
      checked: true,
      indeterminate: false,
    });
    expect(selectionTotals(selectedFigures(parentSelected, byId))).toMatchObject({
      customers: 2,
      invoices: 2,
      amount: 55,
    });
    expect(togglePracticeDoctorSelection(parentSelected, whole, doctors)).toEqual(EMPTY_SELECTION);
    const oneDoctor = selectCustomers(EMPTY_SELECTION, [ada]);
    expect(practiceDoctorSelectionState(oneDoctor, doctors)).toEqual({
      checked: false,
      indeterminate: true,
    });
    expect(togglePracticeDoctorSelection(oneDoctor, whole, doctors).ids).toEqual([ada.id, ben.id]);

    const legacyPracticeSaved = restoreSavedSelection(
      {
        name: "Former whole-practice choice",
        savedAt: "2026-10-25T12:00:00.000Z",
        customers: [{ id: whole.id, name: whole.name, scope: { mode: "invoices", invoiceIds: null } }],
      },
      byId,
    );
    expect(legacyPracticeSaved.selection.ids).toEqual([ada.id, ben.id]);
    expect(selectionTotals(selectedFigures(legacyPracticeSaved.selection, byId))).toMatchObject({
      customers: 2,
      invoices: 2,
      amount: 55,
    });
  });

  it("distinguishes matching display names with original profile names", () => {
    const firstInvoice = {
      ...invoice("shared-a", "INV-101", { total: "40.00", balance: "30.00", doctor: "Dr. Shared" }),
      doctorIdentity: "profile-a",
    };
    const secondInvoice = {
      ...invoice("shared-b", "INV-202", { total: "25.00", balance: "25.00", doctor: "Dr. Shared" }),
      doctorIdentity: "profile-b",
    };
    const [practice] = buildPayableCustomers([], [{
      providerOrganizationId: "shared-practice",
      providerName: "Shared Dental",
      invoiceCount: 2,
      currentBalanceDue: "55.00",
      doctorProfiles: [
        { id: "profile-a", doctorName: "Dr. Alpha", doctorDisplayName: "Dr. Shared" },
        { id: "profile-b", doctorName: "Dr. Beta", doctorDisplayName: "Dr. Shared" },
      ],
      outstandingInvoices: [firstInvoice, secondInvoice],
    }], asOf);
    const accounts = buildSelectablePayableCustomers([practice!]);

    expect(accounts.map((account) => account.name)).toEqual([
      "Dr. Shared (Profile name: Dr. Alpha) · Shared Dental",
      "Dr. Shared (Profile name: Dr. Beta) · Shared Dental",
      "Shared Dental",
    ]);
  });

  it("uses invoice references when duplicate profile names have no distinct original names", () => {
    const firstInvoice = {
      ...invoice("shared-a", "INV-101", { total: "40.00", balance: "30.00", doctor: "Dr. Shared" }),
      doctorIdentity: "profile-a",
    };
    const secondInvoice = {
      ...invoice("shared-b", "INV-202", { total: "25.00", balance: "25.00", doctor: "Dr. Shared" }),
      doctorIdentity: "profile-b",
    };
    const [practice] = buildPayableCustomers([], [{
      providerOrganizationId: "shared-practice",
      providerName: "Shared Dental",
      invoiceCount: 2,
      currentBalanceDue: "55.00",
      doctorProfiles: [
        { id: "profile-a", doctorName: "Dr. Shared", doctorDisplayName: "Dr. Shared" },
        { id: "profile-b", doctorName: " dr.   shared ", doctorDisplayName: "Dr. Shared" },
      ],
      outstandingInvoices: [firstInvoice, secondInvoice],
    }], asOf);
    const accounts = buildSelectablePayableCustomers([practice!]);

    expect(accounts.map((account) => account.name)).toEqual([
      "Dr. Shared (Invoice: INV-101) · Shared Dental",
      "Dr. Shared (Invoice: INV-202) · Shared Dental",
      "Shared Dental",
    ]);
  });

  it("groups legacy invoices by normalized doctor name without inventing a profile identity", () => {
    const legacyOne = invoice("legacy-a", "L-1", { total: "10.00", balance: "10.00", doctor: "Dr. Legacy" });
    const legacyTwo = invoice("legacy-b", "L-2", { total: "20.00", balance: "20.00", doctor: "  dr.   legacy " });
    const other = invoice("legacy-c", "L-3", { total: "15.00", balance: "15.00", doctor: "Dr. Other" });
    const [practice] = buildPayableCustomers([], [{
      providerOrganizationId: "legacy-practice",
      providerName: "Legacy Practice",
      invoiceCount: 3,
      currentBalanceDue: "45.00",
      outstandingInvoices: [legacyOne, legacyTwo, other],
    }], asOf);
    const accounts = buildSelectablePayableCustomers([practice!]);
    const doctors = accounts.filter((account) => account.isDoctorAccount);

    expect(doctors).toHaveLength(2);
    expect(doctors.find((account) => account.doctorIdentity === "dr. legacy")).toMatchObject({
      doctorIdentity: "dr. legacy",
      doctorDisplayName: "Dr. Legacy",
      unpaidCount: 2,
    });
  });
});

describe("heads-up card math", () => {
  it("totals the selected customers' payment scopes", () => {
    const { byId, alpha, beta } = fixture();
    const selection = selectCustomers(EMPTY_SELECTION, [alpha, beta]);
    const totals = selectionTotals(selectedFigures(selection, byId));
    // Alpha pays its statement (2 invoices, $150); Beta pays its invoice ($300).
    expect(totals).toMatchObject({ customers: 2, invoices: 3, amount: 450 });
    // Beta's invoice is 121 days past due: the oldest in the selection.
    expect(totals.oldest?.customerName).toBe("Beta Smiles");
    expect(totals.oldest?.invoice.id).toBe("b1");
    expect(totals.oldest?.invoice.daysPastDue).toBe(121);
  });

  it("counts picked invoices only, at their current balances", () => {
    const { byId, alpha, gamma } = fixture();
    let selection = pickInvoices(EMPTY_SELECTION, alpha, ["a2"], true);
    selection = pickInvoices(selection, gamma, ["g2"], true);
    const totals = selectionTotals(selectedFigures(selection, byId));
    expect(totals).toMatchObject({ customers: 2, invoices: 2, amount: 80 });
    expect(totals.oldest?.invoice.id).toBe("a2");
    expect(totals.oldest?.customerName).toBe("Alpha Dental");
  });

  it("reports no amount when any selected balance is unknown", () => {
    const e1 = invoice("e1", "INV-5001", { due: "2026-06-01", total: "40.00", balance: "40.00" });
    const customers = buildPayableCustomers(
      [
        {
          providerOrganizationId: "eps",
          providerName: "Epsilon Dental",
          statementId: "st-e",
          invoiceCount: 2,
          currentBalanceDue: "90.00",
          statements: [{ statementId: "st-e", sentAt: "2026-06-01", periodStart: null, periodEnd: "2026-05-31", invoiceCount: 2, invoiceIds: ["e1", "e-gone"] }],
          outstandingInvoices: [e1],
        },
      ],
      invoiceRows,
      asOf,
    );
    const byId = new Map(customers.map((customer) => [customer.id, customer]));
    const selection = selectCustomers(EMPTY_SELECTION, customers);
    const totals = selectionTotals(selectedFigures(selection, byId));
    expect(totals.customers).toBe(4);
    expect(totals.amount).toBeNull();
  });

  it("is empty for an empty selection and skips customers that are no longer payable", () => {
    const { byId } = fixture();
    expect(selectionTotals([])).toEqual({ customers: 0, invoices: 0, amount: 0, oldest: null });
    const stale: Selection = { ids: ["gone"], scopes: { gone: { mode: "invoices", invoiceIds: null } } };
    expect(selectionTotals(selectedFigures(stale, byId))).toMatchObject({ customers: 0, amount: 0 });
  });

  it("rounds totals to cents", () => {
    const { byId, gamma } = fixture();
    const cents = buildPayableCustomers(
      [],
      [
        {
          providerOrganizationId: "c",
          providerName: "Cents Dental",
          invoiceCount: 3,
          currentBalanceDue: "1.30",
          outstandingInvoices: [
            invoice("c1", "C-1", { due: "2026-06-01", total: "0.10", balance: "0.10" }),
            invoice("c2", "C-2", { due: "2026-06-02", total: "0.20", balance: "0.20" }),
            invoice("c3", "C-3", { due: "2026-06-03", total: "1.00", balance: "1.00" }),
          ],
        },
      ],
      asOf,
    )[0]!;
    const map = new Map(byId);
    map.set(cents.id, cents);
    // 0.1 + 0.2 is not exactly 0.3 in floating point.
    const selection = pickInvoices(pickInvoices(EMPTY_SELECTION, cents, ["c1", "c2"], true), gamma, ["g1"], true);
    expect(scopeFigures(cents, scopeFor(selection, cents)).amount).toBe(0.3);
    expect(selectionTotals(selectedFigures(selection, map)).amount).toBe(50.3);
  });
});

describe("filters", () => {
  it("searches customer, account number, doctor and invoice number", () => {
    const { customers } = fixture();
    expect(filtered(customers, { search: "beta" })).toEqual(["Beta Smiles"]);
    expect(filtered(customers, { search: "lt-1003" })).toEqual(["Gamma Lab Partners"]);
    expect(filtered(customers, { search: "  Grace " })).toEqual(["Gamma Lab Partners"]);
    expect(filtered(customers, { search: "INV-1003" })).toEqual(["Alpha Dental"]);
    expect(filtered(customers, { search: "nobody" })).toEqual([]);
  });

  it("filters by status", () => {
    const { customers } = fixture();
    expect(filtered(customers, { status: "overdue" })).toEqual(["Alpha Dental", "Beta Smiles"]);
    expect(filtered(customers, { status: "not_due" })).toEqual(["Gamma Lab Partners"]);
    expect(filtered(customers, { status: "partial" })).toEqual(["Alpha Dental"]);
    expect(filtered(customers, { status: "statement" })).toEqual(["Alpha Dental"]);
    expect(filtered(customers, { status: "no_statement" })).toEqual(["Beta Smiles", "Gamma Lab Partners"]);
  });

  it("filters by city/state, including customers with no location on file", () => {
    const { customers } = fixture();
    expect(locationOptions(customers)).toEqual({ locations: ["Austin, TX", "Dallas, TX"], hasMissing: true });
    expect(filtered(customers, { location: "Dallas, TX" })).toEqual(["Beta Smiles"]);
    expect(filtered(customers, { location: NO_LOCATION })).toEqual(["Gamma Lab Partners"]);
  });

  it("filters customers by the aging bucket of their oldest invoice", () => {
    const { customers } = fixture();
    expect(filtered(customers, { aging: AgingBucketKey.d90_plus })).toEqual(["Beta Smiles"]);
    expect(filtered(customers, { aging: AgingBucketKey.d31_60 })).toEqual(["Alpha Dental"]);
    expect(filtered(customers, { aging: AgingBucketKey.current })).toEqual(["Gamma Lab Partners"]);
    expect(filtered(customers, { aging: AgingBucketKey.d61_90 })).toEqual([]);
  });

  it("combines filters and knows when any is active", () => {
    const { customers } = fixture();
    expect(filtered(customers, { status: "overdue", location: "Austin, TX" })).toEqual(["Alpha Dental"]);
    expect(filtersActive(EMPTY_FILTERS)).toBe(false);
    expect(filtersActive({ ...EMPTY_FILTERS, search: "   " })).toBe(false);
    expect(filtersActive({ ...EMPTY_FILTERS, aging: AgingBucketKey.current })).toBe(true);
  });

  it("filters invoices by their own status, aging bucket and patient", () => {
    const { alpha } = fixture();
    const match = (filters: Partial<SelectionFilters>) =>
      alpha.invoices.filter((row) => invoiceMatches(row, alpha, { ...EMPTY_FILTERS, ...filters })).map((row) => row.id);
    expect(match({ status: "statement" })).toEqual(["a1", "a2"]);
    expect(match({ status: "no_statement" })).toEqual(["a3"]);
    expect(match({ status: "overdue" })).toEqual(["a1", "a2"]);
    expect(match({ status: "not_due" })).toEqual(["a3"]);
    expect(match({ status: "partial" })).toEqual(["a2"]);
    expect(match({ aging: AgingBucketKey.d1_30 })).toEqual(["a2"]);
    expect(match({ search: "pat jones" })).toEqual(["a1"]);
    expect(match({ search: "alpha dental" })).toEqual(["a1", "a2", "a3"]);
    expect(match({ location: "Dallas, TX" })).toEqual([]);
  });
});

describe("sorting", () => {
  it("sorts by balance due, name, oldest invoice, unpaid invoices and last payment", () => {
    const { customers } = fixture();
    expect(names(sortCustomers(customers, { key: "balance", direction: "desc" }))).toEqual(["Beta Smiles", "Alpha Dental", "Gamma Lab Partners"]);
    expect(names(sortCustomers(customers, { key: "balance", direction: "asc" }))).toEqual(["Gamma Lab Partners", "Alpha Dental", "Beta Smiles"]);
    expect(names(sortCustomers(customers, { key: "name", direction: "desc" }))).toEqual(["Gamma Lab Partners", "Beta Smiles", "Alpha Dental"]);
    expect(names(sortCustomers(customers, { key: "oldest", direction: "asc" }))).toEqual(["Beta Smiles", "Alpha Dental", "Gamma Lab Partners"]);
    expect(names(sortCustomers(customers, { key: "invoices", direction: "desc" }))).toEqual(["Alpha Dental", "Gamma Lab Partners", "Beta Smiles"]);
    // A customer with no payment on record sorts last in either direction.
    expect(names(sortCustomers(customers, { key: "lastPayment", direction: "desc" }))).toEqual(["Alpha Dental", "Gamma Lab Partners", "Beta Smiles"]);
    expect(names(sortCustomers(customers, { key: "lastPayment", direction: "asc" }))).toEqual(["Gamma Lab Partners", "Alpha Dental", "Beta Smiles"]);
  });

  it("starts a new column in its natural direction and flips the same column", () => {
    expect(nextSort({ key: "balance", direction: "desc" }, "name")).toEqual({ key: "name", direction: "asc" });
    expect(nextSort({ key: "name", direction: "asc" }, "name")).toEqual({ key: "name", direction: "desc" });
    expect(nextSort({ key: "name", direction: "desc" }, "balance")).toEqual({ key: "balance", direction: "desc" });
    expect(nextSort({ key: "balance", direction: "desc" }, "oldest")).toEqual({ key: "oldest", direction: "asc" });
  });
});

describe("selection and invoice scope", () => {
  it("selects customers with their default scope and deselects them", () => {
    const { alpha, beta } = fixture();
    const selection = selectCustomers(EMPTY_SELECTION, [alpha, beta]);
    expect(selection).toEqual({
      ids: ["alpha", "beta"],
      scopes: { alpha: { mode: "statement", invoiceIds: null }, beta: { mode: "invoices", invoiceIds: null } },
    });
    expect(selectCustomers(selection, [alpha])).toBe(selection);
    expect(deselectCustomers(selection, ["alpha"])).toEqual({ ids: ["beta"], scopes: { beta: { mode: "invoices", invoiceIds: null } } });
    expect(deselectCustomers(selection, ["nobody"])).toBe(selection);
  });

  it("limits a statement payment to picked statement invoices", () => {
    const { alpha } = fixture();
    const one = pickInvoices(EMPTY_SELECTION, alpha, ["a1"], true);
    expect(one.ids).toEqual(["alpha"]);
    expect(one.scopes.alpha).toEqual({ mode: "statement", invoiceIds: ["a1"] });
    expect(isInvoicePicked(one, alpha, alpha.invoices[0]!)).toBe(true);
    expect(isInvoicePicked(one, alpha, alpha.invoices[1]!)).toBe(false);
    expect(scopeFigures(alpha, one.scopes.alpha!)).toMatchObject({ invoiceCount: 1, amount: 100 });
    // Picking the rest of the statement goes back to paying the whole statement.
    const both = pickInvoices(one, alpha, ["a2"], true);
    expect(both.scopes.alpha).toEqual({ mode: "statement", invoiceIds: null });
  });

  it("switches a statement customer to paying invoices directly when an off-statement invoice is picked", () => {
    const { alpha } = fixture();
    const selected = selectCustomers(EMPTY_SELECTION, [alpha]);
    const all = pickInvoices(selected, alpha, ["a3"], true);
    expect(all.scopes.alpha).toEqual({ mode: "invoices", invoiceIds: null, switchedFromStatement: true, switchedBy: "INV-1003" });
    expect(scopeFigures(alpha, all.scopes.alpha!)).toMatchObject({ invoiceCount: 3, amount: 200 });

    // Unpicking the off-statement invoice returns to the statement.
    const back = pickInvoices(all, alpha, ["a3"], false);
    expect(back.scopes.alpha).toEqual({ mode: "statement", invoiceIds: null });

    const onlyOff = pickInvoices(EMPTY_SELECTION, alpha, ["a3"], true);
    expect(onlyOff.scopes.alpha).toEqual({ mode: "invoices", invoiceIds: ["a3"], switchedFromStatement: true, switchedBy: "INV-1003" });
    expect(scopeFigures(alpha, onlyOff.scopes.alpha!)).toMatchObject({ invoiceCount: 1, amount: 50 });
    // Choosing the statement again clears the switch.
    expect(selectStatementScope(onlyOff, alpha).scopes.alpha).toEqual({ mode: "statement", invoiceIds: null });
  });

  it("deselects a customer when their last picked invoice is unpicked", () => {
    const { alpha, beta } = fixture();
    const picked = pickInvoices(selectCustomers(EMPTY_SELECTION, [beta]), alpha, ["a2"], true);
    const unpicked = pickInvoices(picked, alpha, ["a2"], false);
    expect(unpicked.ids).toEqual(["beta"]);
    expect(unpicked.scopes.alpha).toBeUndefined();
    expect(pickInvoices(selectCustomers(EMPTY_SELECTION, [beta]), beta, ["b1"], false)).toEqual(EMPTY_SELECTION);
  });

  it("treats picking every invoice of an invoice-led customer as paying all of them", () => {
    const { gamma } = fixture();
    const one = pickInvoices(EMPTY_SELECTION, gamma, ["g1"], true);
    expect(one.scopes.gamma).toEqual({ mode: "invoices", invoiceIds: ["g1"] });
    const both = pickInvoices(one, gamma, ["g2"], true);
    expect(both.scopes.gamma).toEqual({ mode: "invoices", invoiceIds: null });
    expect(isInvoicePicked(EMPTY_SELECTION, gamma, gamma.invoices[0]!)).toBe(false);
    expect(isInvoicePicked(both, gamma, gamma.invoices[0]!)).toBe(true);
  });

  it("prunes customers and picks that are no longer payable, keeping the same object otherwise", () => {
    const { byId, alpha, beta, gamma } = fixture();
    const selection = pickInvoices(selectCustomers(EMPTY_SELECTION, [alpha, beta]), gamma, ["g1"], true);
    expect(pruneSelection(selection, byId)).toBe(selection);

    // Beta paid in full; Gamma's picked invoice was paid; Alpha's statement was paid.
    const later = buildPayableCustomers(
      [],
      [invoiceRows[0]!, { ...invoiceRows[2]!, outstandingInvoices: [g2], currentBalanceDue: "30.00" }],
      asOf,
    );
    const laterById = new Map(later.map((customer) => [customer.id, customer]));
    // Alpha was paying its statement; that is not widened to everything Alpha still owes.
    expect(pruneSelection(selection, laterById)).toEqual(EMPTY_SELECTION);

    // Picked statement invoices still outstanding are paid directly, and a stale switch note is dropped.
    const picked: Selection = {
      ids: ["alpha", "gamma"],
      scopes: {
        alpha: { mode: "statement", invoiceIds: ["a1"] },
        gamma: { mode: "invoices", invoiceIds: null, switchedFromStatement: true, switchedBy: "INV-3001" },
      },
    };
    expect(pruneSelection(picked, laterById)).toEqual({
      ids: ["alpha", "gamma"],
      scopes: { alpha: { mode: "invoices", invoiceIds: ["a1"] }, gamma: { mode: "invoices", invoiceIds: null } },
    });
  });

  it("switches a pruned statement pick that is no longer on the statement", () => {
    const { alpha } = fixture();
    const selection: Selection = { ids: ["alpha"], scopes: { alpha: { mode: "statement", invoiceIds: ["a1", "a3"] } } };
    const pruned = pruneSelection(selection, new Map([[alpha.id, alpha]]));
    expect(pruned.scopes.alpha).toEqual({ mode: "invoices", invoiceIds: ["a1", "a3"], switchedFromStatement: true, switchedBy: "INV-1003" });
  });
});

describe("aging groups", () => {
  it("groups customers by the report's buckets with bucket totals", () => {
    const { customers } = fixture();
    const groups = agingGroups(customers);
    expect(groups.map((group) => group.key)).toEqual([
      AgingBucketKey.current,
      AgingBucketKey.d1_30,
      AgingBucketKey.d31_60,
      AgingBucketKey.d61_90,
      AgingBucketKey.d90_plus,
    ]);
    const summary = Object.fromEntries(
      groups.map((group) => [group.key, { total: group.total, rows: group.rows.map((row) => [row.customer.id, row.invoiceCount, row.balance]) }]),
    );
    expect(summary).toEqual({
      current: { total: 130, rows: [["alpha", 1, 50], ["gamma", 2, 80]] },
      d1_30: { total: 50, rows: [["alpha", 1, 50]] },
      d31_60: { total: 100, rows: [["alpha", 1, 100]] },
      d61_90: { total: 0, rows: [] },
      d90_plus: { total: 300, rows: [["beta", 1, 300]] },
    });
  });

  it("ages a customer without invoice details as current", () => {
    const [legacy] = buildPayableCustomers(
      [{ providerOrganizationId: "delta", providerName: "Delta Ortho", statementId: "st-d", invoiceCount: 4, currentBalanceDue: "500.00" }],
      [],
      asOf,
    );
    const groups = agingGroups([legacy!]);
    expect(groups[0]).toMatchObject({ key: AgingBucketKey.current, total: 500 });
    expect(groups[0]!.rows[0]).toMatchObject({ invoiceCount: 4, balance: 500 });
    expect(groups.slice(1).every((group) => group.rows.length === 0)).toBe(true);
  });
});

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  } as Storage;
  return { storage, values };
}

describe("saved selections", () => {
  const entry = (name: string, ids: string[], savedAt = "2026-06-30T12:00:00.000Z"): SavedSelection => ({
    name,
    savedAt,
    customers: ids.map((id) => ({ id, name: id.toUpperCase() })),
  });

  it("are kept per user and lab", () => {
    expect(savedSelectionsKey("u1", "lab-1")).toBe("labtrax_receive_payment_selections_v1:u1:lab-1");
    expect(savedSelectionsKey("u1", "lab-2")).not.toBe(savedSelectionsKey("u1", "lab-1"));
    expect(savedSelectionsKey("u2", "lab-1")).not.toBe(savedSelectionsKey("u1", "lab-1"));
  });

  it("replace a set with the same name, newest first", () => {
    const first = entry("Monthly", ["alpha"], "2026-06-01T00:00:00.000Z");
    const other = entry("Weekly", ["beta"]);
    const replacement = entry("  monthly ", ["alpha", "beta"]);
    expect(upsertSavedSelection([other, first], replacement)).toEqual([replacement, other]);
  });

  it("round-trip through storage and ignore malformed data", () => {
    const { storage, values } = memoryStorage();
    const key = savedSelectionsKey("u1", "lab-1");
    const sets = [entry("Monthly", ["alpha", "beta"])];
    expect(writeSavedSelections(storage, key, sets)).toBe(true);
    expect(readSavedSelections(storage, key)).toEqual(sets);

    values.set(key, "{not json");
    expect(readSavedSelections(storage, key)).toEqual([]);
    values.set(key, JSON.stringify({ name: "x" }));
    expect(readSavedSelections(storage, key)).toEqual([]);
    values.set(key, JSON.stringify([sets[0], { name: "Broken", savedAt: 1, customers: [] }, { name: "No ids", savedAt: "x", customers: [{ name: "A" }] }]));
    expect(readSavedSelections(storage, key)).toEqual(sets);

    // Deleting the last set removes the key.
    expect(writeSavedSelections(storage, key, [])).toBe(true);
    expect(values.has(key)).toBe(false);
    expect(readSavedSelections(null, key)).toEqual([]);
    expect(writeSavedSelections(null, key, sets)).toBe(false);
  });

  it("report a failed write instead of throwing", () => {
    const { storage } = memoryStorage();
    storage.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    expect(writeSavedSelections(storage, "k", [entry("Monthly", ["alpha"])])).toBe(false);
  });

  it("keep each customer's payment scope and reject malformed scopes", () => {
    const { storage, values } = memoryStorage();
    const key = savedSelectionsKey("u1", "lab-1");
    const { byId, alpha, beta, gamma } = fixture();
    const selection = pickInvoices(pickInvoices(selectCustomers(EMPTY_SELECTION, [beta]), alpha, ["a1"], true), gamma, ["g1"], true);
    const customers = savedSelectionCustomers(selection, byId);
    expect(customers).toEqual([
      { id: "beta", name: "Beta Smiles", scope: { mode: "invoices", invoiceIds: null } },
      { id: "alpha", name: "Alpha Dental", scope: { mode: "statement", invoiceIds: ["a1"] } },
      { id: "gamma", name: "Gamma Lab Partners", scope: { mode: "invoices", invoiceIds: ["g1"] } },
    ]);
    const sets: SavedSelection[] = [{ name: "Partial", savedAt: "2026-06-30T12:00:00.000Z", customers }];
    expect(writeSavedSelections(storage, key, sets)).toBe(true);
    expect(readSavedSelections(storage, key)).toEqual(sets);

    const withScope = (scope: unknown) => ({ name: "Bad", savedAt: "x", customers: [{ id: "alpha", name: "Alpha", scope }] });
    for (const scope of [
      null,
      "statement",
      { mode: "credit", invoiceIds: null },
      { mode: "statement" },
      { mode: "invoices", invoiceIds: "a1" },
      { mode: "invoices", invoiceIds: [1] },
      { mode: "invoices", invoiceIds: null, switchedFromStatement: "yes" },
      { mode: "invoices", invoiceIds: null, switchedBy: 3 },
    ]) {
      values.set(key, JSON.stringify([sets[0], withScope(scope)]));
      expect(readSavedSelections(storage, key)).toEqual(sets);
    }
  });

  it("restore each saved scope in the saved order and name customers that are no longer payable", () => {
    const { byId } = fixture();
    const saved: SavedSelection = {
      name: "Monthly",
      savedAt: "2026-06-01T00:00:00.000Z",
      customers: [
        { id: "gamma", name: "Gamma Lab Partners", scope: { mode: "invoices", invoiceIds: ["g1"] } },
        { id: "omega", name: "Omega Dental", scope: { mode: "invoices", invoiceIds: null } },
        { id: "alpha", name: "Alpha Dental", scope: { mode: "statement", invoiceIds: ["a1"] } },
        // Saved before scopes were kept: the default scope applies.
        { id: "beta", name: "Beta Smiles" },
        { id: "gamma", name: "Gamma Lab Partners" },
      ],
    };
    const restored = restoreSavedSelection(saved, byId);
    expect(restored.selection).toEqual({
      ids: ["gamma", "alpha", "beta"],
      scopes: {
        gamma: { mode: "invoices", invoiceIds: ["g1"] },
        alpha: { mode: "statement", invoiceIds: ["a1"] },
        beta: { mode: "invoices", invoiceIds: null },
      },
    });
    expect(restored.missing).toEqual([{ id: "omega", name: "Omega Dental" }]);
    expect(restored.unselected).toEqual([]);
    expect(restored.narrowed).toEqual([]);
    expect(selectionTotals(selectedFigures(restored.selection, byId))).toMatchObject({ customers: 3, invoices: 3, amount: 450 });
  });

  it("narrow saved picks to invoices still outstanding and leave a customer unselected when none are", () => {
    // Since saving: INV-1001 and INV-3001 were paid, and Beta paid in full.
    const alphaLater: EligibleAccount = {
      ...alphaStatementRow,
      currentBalanceDue: "50.00",
      invoiceCount: 1,
      outstandingInvoices: [a2],
      statements: [{ ...alphaStatementRow.statements![0]!, invoiceCount: 1, invoiceIds: ["a2"] }],
    };
    const later = buildPayableCustomers(
      [alphaLater],
      [
        { ...invoiceRows[0]!, outstandingInvoices: [a3, a2], currentBalanceDue: "100.00", invoiceCount: 2 },
        { ...invoiceRows[2]!, outstandingInvoices: [g2], currentBalanceDue: "30.00", invoiceCount: 1 },
      ],
      asOf,
    );
    const byId = new Map(later.map((customer) => [customer.id, customer]));
    const restored = restoreSavedSelection(
      {
        name: "Partial",
        savedAt: "2026-06-01T00:00:00.000Z",
        customers: [
          { id: "alpha", name: "Alpha Dental", scope: { mode: "statement", invoiceIds: ["a1", "a2"] } },
          { id: "gamma", name: "Gamma Lab Partners", scope: { mode: "invoices", invoiceIds: ["g1"] } },
          { id: "beta", name: "Beta Smiles", scope: { mode: "invoices", invoiceIds: null } },
        ],
      },
      byId,
    );
    // Alpha's statement now covers only INV-1002; INV-1003, which was never picked, stays out.
    expect(restored.selection).toEqual({ ids: ["alpha"], scopes: { alpha: { mode: "statement", invoiceIds: null } } });
    expect(restored.narrowed).toEqual([{ id: "alpha", name: "Alpha Dental" }]);
    expect(restored.unselected).toEqual([{ id: "gamma", name: "Gamma Lab Partners", reason: "invoices" }]);
    expect(restored.missing).toEqual([{ id: "beta", name: "Beta Smiles" }]);
    expect(selectionTotals(selectedFigures(restored.selection, byId))).toMatchObject({ customers: 1, invoices: 1, amount: 50 });
  });

  it("never widen a statement payment once the statement is no longer payable, and keep explicit invoice choices", () => {
    const noStatement = new Map(buildPayableCustomers([], invoiceRows, asOf).map((customer) => [customer.id, customer]));
    const restoreAlpha = (scope: CustomerScope, byId: ReadonlyMap<string, PayableCustomer> = noStatement) =>
      restoreSavedSelection(
        { name: "One", savedAt: "2026-06-01T00:00:00.000Z", customers: [{ id: "alpha", name: "Alpha Dental", scope }] },
        byId,
      );

    const statementGone = restoreAlpha({ mode: "statement", invoiceIds: null });
    expect(statementGone.selection).toEqual(EMPTY_SELECTION);
    expect(statementGone.unselected).toEqual([{ id: "alpha", name: "Alpha Dental", reason: "statement" }]);
    expect(statementGone.missing).toEqual([]);

    // A switch away from a statement that is gone pays the same invoices, without the stale note.
    expect(
      restoreAlpha({ mode: "invoices", invoiceIds: null, switchedFromStatement: true, switchedBy: "INV-1003" }).selection.scopes,
    ).toEqual({ alpha: { mode: "invoices", invoiceIds: null } });

    const { byId } = fixture();
    // While the statement is payable, the note names an off-statement invoice that is still outstanding.
    expect(
      restoreAlpha({ mode: "invoices", invoiceIds: null, switchedFromStatement: true, switchedBy: "INV-0999" }, byId).selection.scopes,
    ).toEqual({ alpha: { mode: "invoices", invoiceIds: null, switchedFromStatement: true, switchedBy: "INV-1003" } });
    // Choosing "No statement" is kept even though Alpha has a payable statement.
    expect(restoreAlpha({ mode: "invoices", invoiceIds: null }, byId).selection.scopes).toEqual({
      alpha: { mode: "invoices", invoiceIds: null },
    });
  });
});

describe("drafts start from the Payment Summary", () => {
  const defaults: PaymentDefaults = { paymentMethod: "ach", paymentDate: "2026-06-29", memo: "June payments" };

  it("carries the method, date and memo into a fresh draft", () => {
    expect(draftWithDefaults("", defaults)).toMatchObject({
      statementId: "",
      paymentMethod: "ach",
      paymentDate: "2026-06-29",
      memo: "June payments",
      totalReceived: "",
      referenceNumber: "",
    });
    expect(draftWithDefaults("st-1", null)).toMatchObject({
      statementId: "st-1",
      paymentMethod: "check",
      paymentDate: localCalendarDate(),
      memo: "",
    });
    // Every draft is its own payment with its own idempotency key.
    expect(draftWithDefaults("", defaults).idempotencyKey).not.toBe(draftWithDefaults("", defaults).idempotencyKey);
  });

  it("starts a statement customer on their statement, filled in once it loads", () => {
    const { alpha } = fixture();
    expect(batchDraft(alpha, { mode: "statement", invoiceIds: null }, defaults)).toMatchObject({
      statementId: "st-a2",
      scopeInvoiceIds: null,
      totalReceived: "",
      applications: {},
      paymentMethod: "ach",
      paymentDate: "2026-06-29",
      memo: "June payments",
    });
    expect(batchDraft(alpha, { mode: "statement", invoiceIds: ["a1"] }, defaults)).toMatchObject({
      statementId: "st-a2",
      scopeInvoiceIds: ["a1"],
      totalReceived: "",
    });
  });

  it("starts an invoice-led customer receiving each picked invoice's full balance", () => {
    const { alpha, beta, gamma } = fixture();
    expect(batchDraft(beta, { mode: "invoices", invoiceIds: null }, defaults)).toMatchObject({
      statementId: "",
      scopeInvoiceIds: null,
      totalReceived: "300.00",
      applications: { b1: "300.00" },
      memo: "June payments",
    });
    expect(batchDraft(gamma, { mode: "invoices", invoiceIds: ["g2"] }, defaults)).toMatchObject({
      totalReceived: "30.00",
      applications: { g2: "30.00" },
      scopeInvoiceIds: ["g2"],
    });
    // A statement customer switched to paying an off-statement invoice.
    const switched = pickInvoices(EMPTY_SELECTION, alpha, ["a3"], true).scopes.alpha!;
    expect(batchDraft(alpha, switched, defaults)).toMatchObject({
      statementId: "",
      totalReceived: "50.00",
      applications: { a3: "50.00" },
      scopeInvoiceIds: ["a3"],
    });
  });

  it("allocates an amount to the oldest invoices first, each up to its balance", () => {
    expect(allocateOldestFirst([a2, a1, a3], 120)).toEqual({ a1: "100.00", a2: "20.00" });
    expect(allocateOldestFirst([a2, a1, a3], 500)).toEqual({ a1: "100.00", a2: "50.00", a3: "50.00" });
    expect(allocateOldestFirst([a1], 0)).toEqual({});
  });
});
