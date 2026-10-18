/**
 * Regression tests for the on-demand "Generate Statements" workflow rebuilt in
 * task 2838. These exercise the scope-based, recipient-aware statement builder
 * and the secure SMS statement-link token:
 *
 *  1. buildPracticeStatementsForScope — practice vs doctor grouping, the
 *     recipient-sourcing fix (grouping never depends on a parent-lab link),
 *     selection filters, and the open-balance post-filter for balance scopes.
 *
 *  2. getStatementLinkPdf — an unknown or expired token serves nothing (the
 *     time-limited-link security guarantee).
 *
 * Both hit the DB, so @workspace/db and drizzle-orm operators are fully mocked
 * here. WHERE clauses are inert in the mock, so scope-specific SQL filtering is
 * simulated by controlling the rows the mock returns; the tests assert only the
 * grouping / filtering / balance logic that runs in JS.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock handles.
// ---------------------------------------------------------------------------

const mockInvoicesFindMany = vi.hoisted(() => vi.fn());
const mockLineItemsFindMany = vi.hoisted(() => vi.fn());
const mockTokenFindFirst = vi.hoisted(() => vi.fn());
// select().from(cases|organizations).where() resolvers, switched by table tag.
const mockCaseRows = vi.hoisted(() => vi.fn(() => [] as any[]));
const mockOrgRows = vi.hoisted(() => vi.fn(() => [] as any[]));
const mockPaymentRows = vi.hoisted(() => vi.fn(() => [] as any[]));

// ---------------------------------------------------------------------------
// Mock @workspace/db. Table exports are plain tagged objects; real column refs
// are never traversed because drizzle-orm operators are mocked below.
// ---------------------------------------------------------------------------

vi.mock("@workspace/db", () => {
  const casesTable = { __name: "cases", id: {}, doctorName: {} };
  const organizationsTable = {
    __name: "organizations",
    id: {},
    name: {},
    displayName: {},
    billingEmail: {},
  };
  const paymentsTable = {
    __name: "payments",
    id: {},
    invoiceId: {},
    amount: {},
    paidAt: {},
    paymentMethod: {},
    referenceNumber: {},
  };

  const db = {
    query: {
      invoices: { findMany: mockInvoicesFindMany },
      invoiceLineItems: { findMany: mockLineItemsFindMany },
      statementLinkTokens: { findFirst: mockTokenFindFirst },
      organizations: { findFirst: vi.fn().mockResolvedValue(null) },
    },
    select: vi.fn((_cols?: unknown) => ({
      from: (tbl: { __name?: string }) => {
        const rows =
          tbl && tbl.__name === "cases"
            ? mockCaseRows()
            : tbl && tbl.__name === "payments"
              ? mockPaymentRows()
              : mockOrgRows();
        return {
          where: () => {
            const result = Promise.resolve(rows) as Promise<any[]> & {
              orderBy: () => Promise<any[]>;
            };
            result.orderBy = () => result;
            return result;
          },
        };
      },
    })),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    }),
  };

  return {
    db,
    cases: casesTable,
    payments: paymentsTable,
    organizations: organizationsTable,
    invoices: {
      labOrganizationId: {},
      status: {},
      issuedAt: {},
      dueAt: {},
      createdAt: {},
      providerOrganizationId: {},
    },
    invoiceLineItems: { invoiceId: {}, sortOrder: {} },
    statementLinkTokens: { token: {} },
  };
});

// ---------------------------------------------------------------------------
// Mock drizzle-orm operators — inert, they only need to not throw.
// ---------------------------------------------------------------------------

vi.mock("drizzle-orm", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
  eq: () => ({}),
  and: () => ({}),
  or: () => ({}),
  ne: () => ({}),
  gte: () => ({}),
  gt: () => ({}),
  lt: () => ({}),
  lte: () => ({}),
  isNull: () => ({}),
  inArray: () => ({}),
  asc: () => ({}),
  desc: () => ({}),
  notInArray: () => ({}),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInvoice(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: `inv-${Math.random().toString(36).slice(2)}`,
    labOrganizationId: "lab-1",
    providerOrganizationId: "org-a",
    caseId: null,
    invoiceNumber: "INV-001",
    status: "sent",
    total: "100.00",
    balanceDue: "100.00",
    createdAt: new Date("2025-04-15T00:00:00Z"),
    issuedAt: new Date("2025-04-15T00:00:00Z"),
    dueAt: null,
    displayMetadataJson: null,
    ...overrides,
  };
}

function makeOrg(
  id: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id,
    name: `Practice ${id}`,
    displayName: `Practice ${id}`,
    billingEmail: `${id}@example.com`,
    phone: null,
    statementEmailOptOut: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildPracticeStatementsForScope
// ---------------------------------------------------------------------------

describe("buildPracticeStatementsForScope — practice grouping", () => {
  let buildPracticeStatementsForScope: (
    labOrganizationId: string,
    opts: import("./statements.js").BuildScopeOptions
  ) => Promise<import("./statements.js").PracticeStatementData[]>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockLineItemsFindMany.mockResolvedValue([]);
    mockCaseRows.mockReturnValue([]);
    mockOrgRows.mockReturnValue([]);
    mockPaymentRows.mockReturnValue([]);
    ({ buildPracticeStatementsForScope } = await import("./statements.js"));
  });

  it("groups invoices by providerOrganizationId regardless of any parent-lab link (recipient-sourcing fix)", async () => {
    // Neither org row carries parentLabOrganizationId — proving grouping never
    // consults it. A practice with invoices but no parent link must still show.
    mockInvoicesFindMany.mockResolvedValue([
      makeInvoice({ providerOrganizationId: "org-a" }),
      makeInvoice({ providerOrganizationId: "org-b" }),
    ]);
    mockOrgRows.mockReturnValue([makeOrg("org-a"), makeOrg("org-b")]);

    const result = await buildPracticeStatementsForScope("lab-1", { scope: "all" });

    const ids = result.map((r) => r.practiceId).sort();
    expect(ids).toEqual(["org-a", "org-b"]);
    expect(result.every((r) => r.recipientType === "practice")).toBe(true);
  });

  it("attaches the most recent payment date and method to each statement group", async () => {
    const olderInvoice = makeInvoice({
      id: "inv-older",
      providerOrganizationId: "org-a",
    });
    const newerInvoice = makeInvoice({
      id: "inv-newer",
      providerOrganizationId: "org-a",
    });
    mockInvoicesFindMany.mockResolvedValue([olderInvoice, newerInvoice]);
    mockOrgRows.mockReturnValue([makeOrg("org-a")]);
    mockPaymentRows.mockReturnValue([
      {
        invoiceId: "inv-newer",
        paidAt: new Date("2026-07-10T09:00:00.000Z"),
        paymentMethod: "ach",
      },
      {
        invoiceId: "inv-older",
        paidAt: new Date("2026-06-05T09:00:00.000Z"),
        paymentMethod: "check",
      },
    ]);

    const [result] = await buildPracticeStatementsForScope("lab-1", {
      scope: "all",
    });

    expect(result?.paidAt).toEqual(new Date("2026-07-10T09:00:00.000Z"));
    expect(result?.paymentMethod).toBe("ach");
  });

  it("hydrates every payment row for the included invoices in stable chronological order", async () => {
    mockInvoicesFindMany.mockResolvedValue([
      makeInvoice({
        id: "inv-older",
        providerOrganizationId: "org-a",
        issuedAt: new Date("2025-04-01T00:00:00Z"),
      }),
      makeInvoice({
        id: "inv-newer",
        providerOrganizationId: "org-a",
        issuedAt: new Date("2025-04-02T00:00:00Z"),
      }),
    ]);
    mockOrgRows.mockReturnValue([makeOrg("org-a")]);
    const sameTime = new Date("2025-04-03T00:00:00Z");
    mockPaymentRows.mockReturnValue([
      {
        id: "payment-b",
        invoiceId: "inv-newer",
        amount: "25.00",
        paidAt: sameTime,
        paymentMethod: "card",
        referenceNumber: "B",
      },
      {
        id: "payment-a",
        invoiceId: "inv-older",
        amount: "40.00",
        paidAt: sameTime,
        paymentMethod: "check",
        referenceNumber: "A",
      },
      {
        id: "payment-early",
        invoiceId: "inv-older",
        amount: "10.00",
        paidAt: new Date("2025-04-02T00:00:00Z"),
        paymentMethod: "cash",
        referenceNumber: null,
      },
    ]);

    const [result] = await buildPracticeStatementsForScope("lab-1", {
      scope: "all",
    });

    expect(result?.payments).toEqual([
      {
        id: "payment-early",
        invoiceId: "inv-older",
        amount: "10.00",
        paidAt: new Date("2025-04-02T00:00:00Z"),
        paymentMethod: "cash",
        referenceNumber: null,
      },
      {
        id: "payment-a",
        invoiceId: "inv-older",
        amount: "40.00",
        paidAt: sameTime,
        paymentMethod: "check",
        referenceNumber: "A",
      },
      {
        id: "payment-b",
        invoiceId: "inv-newer",
        amount: "25.00",
        paidAt: sameTime,
        paymentMethod: "card",
        referenceNumber: "B",
      },
    ]);
    expect(result?.paidAt).toEqual(sameTime);
    expect(result?.paymentMethod).toBe("card");
  });

  it("skips invoices with no provider org (legacy mobile) in practice mode", async () => {
    mockInvoicesFindMany.mockResolvedValue([
      makeInvoice({ providerOrganizationId: "org-a" }),
      makeInvoice({ providerOrganizationId: null }),
    ]);
    mockOrgRows.mockReturnValue([makeOrg("org-a")]);

    const result = await buildPracticeStatementsForScope("lab-1", { scope: "all" });

    expect(result.map((r) => r.practiceId)).toEqual(["org-a"]);
  });

  it("restricts to the selected practiceIds", async () => {
    mockInvoicesFindMany.mockResolvedValue([
      makeInvoice({ providerOrganizationId: "org-a" }),
      makeInvoice({ providerOrganizationId: "org-b" }),
      makeInvoice({ providerOrganizationId: "org-c" }),
    ]);
    mockOrgRows.mockReturnValue([makeOrg("org-a"), makeOrg("org-b"), makeOrg("org-c")]);

    const result = await buildPracticeStatementsForScope("lab-1", {
      scope: "all",
      practiceIds: ["org-a", "org-c"],
    });

    expect(result.map((r) => r.practiceId).sort()).toEqual(["org-a", "org-c"]);
  });

  it("aggregates billed / paid / open across a practice's invoices", async () => {
    mockInvoicesFindMany.mockResolvedValue([
      makeInvoice({ providerOrganizationId: "org-a", total: "200.00", balanceDue: "50.00" }),
      makeInvoice({ providerOrganizationId: "org-a", total: "150.00", balanceDue: "0.00" }),
    ]);
    mockOrgRows.mockReturnValue([makeOrg("org-a")]);

    const result = await buildPracticeStatementsForScope("lab-1", { scope: "all" });

    expect(result).toHaveLength(1);
    expect(result[0]!.invoiceCount).toBe(2);
    expect(result[0]!.totalBilled).toBeCloseTo(350);
    expect(result[0]!.totalPaid).toBeCloseTo(300);
    expect(result[0]!.openBalance).toBeCloseTo(50);
  });
});

describe("buildPracticeStatementsForScope — balance-scoped post-filter", () => {
  let buildPracticeStatementsForScope: (
    labOrganizationId: string,
    opts: import("./statements.js").BuildScopeOptions
  ) => Promise<import("./statements.js").PracticeStatementData[]>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockLineItemsFindMany.mockResolvedValue([]);
    mockCaseRows.mockReturnValue([]);
    mockOrgRows.mockReturnValue([]);
    ({ buildPracticeStatementsForScope } = await import("./statements.js"));
  });

  it('"open" scope drops groups whose open balance is zero', async () => {
    mockInvoicesFindMany.mockResolvedValue([
      makeInvoice({ providerOrganizationId: "org-a", balanceDue: "40.00" }),
      makeInvoice({ providerOrganizationId: "org-b", balanceDue: "0.00" }),
    ]);
    mockOrgRows.mockReturnValue([makeOrg("org-a"), makeOrg("org-b")]);

    const result = await buildPracticeStatementsForScope("lab-1", { scope: "open" });

    expect(result.map((r) => r.practiceId)).toEqual(["org-a"]);
  });

  it('"all" scope keeps zero-open-balance groups', async () => {
    mockInvoicesFindMany.mockResolvedValue([
      makeInvoice({ providerOrganizationId: "org-a", balanceDue: "0.00" }),
    ]);
    mockOrgRows.mockReturnValue([makeOrg("org-a")]);

    const result = await buildPracticeStatementsForScope("lab-1", { scope: "all" });

    expect(result.map((r) => r.practiceId)).toEqual(["org-a"]);
  });
});

describe("buildPracticeStatementsForScope — doctor grouping", () => {
  let buildPracticeStatementsForScope: (
    labOrganizationId: string,
    opts: import("./statements.js").BuildScopeOptions
  ) => Promise<import("./statements.js").PracticeStatementData[]>;
  let NO_DOCTOR_KEY: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockLineItemsFindMany.mockResolvedValue([]);
    mockCaseRows.mockReturnValue([]);
    mockOrgRows.mockReturnValue([]);
    const mod = await import("./statements.js");
    buildPracticeStatementsForScope = mod.buildPracticeStatementsForScope;
    NO_DOCTOR_KEY = mod.NO_DOCTOR_KEY;
  });

  it("groups by resolved case doctor (scoped to one provider org) and buckets unresolved invoices under NO_DOCTOR_KEY", async () => {
    mockInvoicesFindMany.mockResolvedValue([
      makeInvoice({ id: "inv-1", caseId: "case-1", providerOrganizationId: "org-a" }),
      makeInvoice({ id: "inv-2", caseId: "case-2", providerOrganizationId: "org-a" }),
      makeInvoice({ id: "inv-3", caseId: null, providerOrganizationId: "org-a" }),
    ]);
    mockCaseRows.mockReturnValue([
      { id: "case-1", doctorName: "Dr. Synthetic063" },
      { id: "case-2", doctorName: "Dr. Synthetic063" },
    ]);
    mockOrgRows.mockReturnValue([makeOrg("org-a")]);

    const result = await buildPracticeStatementsForScope("lab-1", {
      scope: "all",
      recipientType: "doctor",
    });

    const byKey = new Map(result.map((r) => [r.practiceId, r]));
    // Composite key scopes each doctor recipient to a single provider org.
    expect(byKey.get(`org-a::Dr. Synthetic063`)!.invoiceCount).toBe(2);
    expect(byKey.get(`org-a::Dr. Synthetic063`)!.practiceName).toBe("Dr. Synthetic063");
    expect(byKey.get(`org-a::${NO_DOCTOR_KEY}`)!.invoiceCount).toBe(1);
    expect(result.every((r) => r.recipientType === "doctor")).toBe(true);
  });

  it("never merges the same doctor across practices — separate groups, each with its own contact (confidentiality guardrail)", async () => {
    // Dr. Synthetic063 bills at BOTH org-a and org-b. Grouping by doctor name alone
    // would merge them and deliver one combined PDF to a single practice
    // contact, leaking org-b's invoices to org-a (or vice versa).
    mockInvoicesFindMany.mockResolvedValue([
      makeInvoice({ id: "inv-1", caseId: "case-1", providerOrganizationId: "org-a", total: "100.00", balanceDue: "100.00" }),
      makeInvoice({ id: "inv-2", caseId: "case-2", providerOrganizationId: "org-b", total: "200.00", balanceDue: "200.00" }),
    ]);
    mockCaseRows.mockReturnValue([
      { id: "case-1", doctorName: "Dr. Synthetic063" },
      { id: "case-2", doctorName: "Dr. Synthetic063" },
    ]);
    mockOrgRows.mockReturnValue([
      makeOrg("org-a", { billingEmail: "a@example.com" }),
      makeOrg("org-b", { billingEmail: "b@example.com" }),
    ]);

    const result = await buildPracticeStatementsForScope("lab-1", {
      scope: "all",
      recipientType: "doctor",
    });

    expect(result.map((r) => r.practiceId).sort()).toEqual([
      "org-a::Dr. Synthetic063",
      "org-b::Dr. Synthetic063",
    ]);
    const byKey = new Map(result.map((r) => [r.practiceId, r]));
    // Each group carries only its own practice's invoice + contact.
    expect(byKey.get("org-a::Dr. Synthetic063")!.invoiceCount).toBe(1);
    expect(byKey.get("org-a::Dr. Synthetic063")!.totalBilled).toBeCloseTo(100);
    expect(byKey.get("org-a::Dr. Synthetic063")!.practiceEmail).toBe("a@example.com");
    expect(byKey.get("org-a::Dr. Synthetic063")!.providerOrganizationId).toBe("org-a");
    expect(byKey.get("org-b::Dr. Synthetic063")!.invoiceCount).toBe(1);
    expect(byKey.get("org-b::Dr. Synthetic063")!.totalBilled).toBeCloseTo(200);
    expect(byKey.get("org-b::Dr. Synthetic063")!.practiceEmail).toBe("b@example.com");
    expect(byKey.get("org-b::Dr. Synthetic063")!.providerOrganizationId).toBe("org-b");
  });

  it("restricts to the selected doctorKeys (composite keys)", async () => {
    mockInvoicesFindMany.mockResolvedValue([
      makeInvoice({ id: "inv-1", caseId: "case-1", providerOrganizationId: "org-a" }),
      makeInvoice({ id: "inv-2", caseId: "case-2", providerOrganizationId: "org-a" }),
    ]);
    mockCaseRows.mockReturnValue([
      { id: "case-1", doctorName: "Dr. Synthetic063" },
      { id: "case-2", doctorName: "Dr. Synthetic047" },
    ]);
    mockOrgRows.mockReturnValue([makeOrg("org-a")]);

    const result = await buildPracticeStatementsForScope("lab-1", {
      scope: "all",
      recipientType: "doctor",
      doctorKeys: ["org-a::Dr. Synthetic063"],
    });

    expect(result.map((r) => r.practiceId)).toEqual(["org-a::Dr. Synthetic063"]);
  });
});

// ---------------------------------------------------------------------------
// getStatementLinkPdf — token validity guarantees
// ---------------------------------------------------------------------------

describe("getStatementLinkPdf — token validity", () => {
  let getStatementLinkPdf: (
    token: string
  ) => Promise<{ pdfBuffer: Buffer; filename: string } | null>;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ getStatementLinkPdf } = await import("./statements.js"));
  });

  it("returns null for an unknown token", async () => {
    mockTokenFindFirst.mockResolvedValue(undefined);

    const result = await getStatementLinkPdf("does-not-exist");

    expect(result).toBeNull();
  });

  it("returns null for an expired token (never serves a stale link)", async () => {
    mockTokenFindFirst.mockResolvedValue({
      token: "expired",
      labOrganizationId: "lab-1",
      recipientType: "practice",
      recipientKey: "org-a",
      invoiceScope: "open",
      customFrom: null,
      customTo: null,
      periodLabel: null,
      expiresAt: new Date(Date.now() - 60_000),
    });

    const result = await getStatementLinkPdf("expired");

    expect(result).toBeNull();
  });
});
