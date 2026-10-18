import type { CanonicalInvoice } from "./mobile-hooks";
import type { InvoiceFilterOptions } from "./invoice-filters";

export const INVOICE_FILTER_PARITY_NOW = new Date(2026, 6, 7, 14);

export function invoiceFilterParityInvoice(
  id: string,
  overrides: Partial<CanonicalInvoice> = {},
): CanonicalInvoice {
  return {
    id,
    invoiceNumber: id.toUpperCase(),
    status: "open",
    total: 100,
    balanceDue: 100,
    ...overrides,
  };
}

export const INVOICE_FILTER_PARITY_ROWS: CanonicalInvoice[] = [
  invoiceFilterParityInvoice("open-past", {
    dueAt: new Date(2026, 6, 6).toISOString(),
    issuedAt: new Date(2026, 6, 7).toISOString(),
    providerOrganizationId: "p2",
    providerOrganization: { name: "Zenith" },
    displayMetadataJson: { patientName: "Amy", billTo: "Dr Z" },
    aiGenerated: true,
  }),
  invoiceFilterParityInvoice("partial-past", {
    status: "partially_paid",
    dueAt: new Date(2026, 5, 1).toISOString(),
    issuedAt: new Date(2026, 5, 1).toISOString(),
    providerOrganizationId: "p1",
    providerOrganization: { name: "Acme" },
    displayMetadataJson: { patientName: "Ben", billTo: "Dr A" },
  }),
  invoiceFilterParityInvoice("overdue-status", {
    status: "overdue",
    total: 80,
    balanceDue: 80,
    dueAt: new Date(2026, 6, 6).toISOString(),
    issuedAt: new Date(2026, 6, 6).toISOString(),
  }),
  invoiceFilterParityInvoice("paid-zero", {
    status: "paid",
    balanceDue: 0,
    dueAt: new Date(2026, 6, 1).toISOString(),
    issuedAt: new Date(2026, 6, 2).toISOString(),
    providerOrganizationId: "p1",
    providerOrganization: { name: "Acme" },
  }),
  invoiceFilterParityInvoice("void-zero", {
    status: "void",
    balanceDue: 0,
    dueAt: new Date(2026, 6, 3).toISOString(),
    issuedAt: new Date(2026, 6, 3).toISOString(),
    frozen: true,
  }),
  invoiceFilterParityInvoice("created-fallback", {
    status: "void",
    issuedAt: null,
    createdAt: new Date(2026, 6, 7).toISOString(),
  }),
];

export const INVOICE_FILTER_PARITY_CASES: {
  name: string;
  options: InvoiceFilterOptions;
  expectedIds: string[];
}[] = [
  {
    name: "Open",
    options: { view: "open", statuses: [], date: "all" },
    expectedIds: ["open-past", "partial-past"],
  },
  {
    name: "Outstanding ignores stale status and aging selections",
    options: {
      view: "outstanding",
      statuses: ["paid"],
      overdue: "0_30",
      date: "all",
    },
    expectedIds: ["open-past", "partial-past"],
  },
  {
    name: "status selections use union semantics",
    options: { statuses: ["paid", "frozen"], date: "all" },
    expectedIds: ["void-zero", "paid-zero"],
  },
  {
    name: "Open takes precedence over a stale $0 balance selection",
    options: { view: "open", statuses: ["zero_balance"], date: "all" },
    expectedIds: ["open-past", "partial-past"],
  },
  {
    name: "view takes precedence over modern and legacy status selections",
    options: { view: "open", statuses: ["paid"], status: "void", date: "all" },
    expectedIds: ["open-past", "partial-past"],
  },
  {
    name: "modern statuses take precedence over the legacy status selection",
    options: { statuses: ["paid"], status: "void", date: "all" },
    expectedIds: ["paid-zero"],
  },
  {
    name: "legacy open status normalizes to the Open view",
    options: { status: "open", date: "all" },
    expectedIds: ["open-past", "partial-past"],
  },
  {
    name: "legacy closed status includes paid and void invoices",
    options: { status: "closed", date: "all" },
    expectedIds: ["created-fallback", "void-zero", "paid-zero"],
  },
  {
    name: "legacy overdue status includes overdue invoices with a balance",
    options: { status: "overdue", date: "all" },
    expectedIds: ["open-past", "overdue-status", "partial-past"],
  },
  {
    name: "Open still applies an aging selection",
    options: {
      view: "open",
      overdue: "custom",
      overdueCustomStart: new Date(2026, 6, 7),
      overdueCustomEnd: new Date(2026, 6, 7),
      date: "all",
    },
    expectedIds: ["open-past"],
  },
  {
    name: "search, practice, doctor, AI, and date use intersection semantics",
    options: {
      search: "amy",
      practiceId: "p2",
      doctorName: "Dr Z",
      aiOnly: true,
      date: "today",
    },
    expectedIds: ["open-past"],
  },
  {
    name: "issued date falls back to created date",
    options: {
      date: "custom",
      customStart: new Date(2026, 6, 7),
      customEnd: new Date(2026, 6, 7),
    },
    expectedIds: ["open-past", "created-fallback"],
  },
  {
    name: "custom aging filters by issued date",
    options: {
      date: "all",
      overdue: "custom",
      overdueCustomStart: new Date(2026, 5, 1),
      overdueCustomEnd: new Date(2026, 5, 30),
    },
    expectedIds: ["partial-past"],
  },
];
