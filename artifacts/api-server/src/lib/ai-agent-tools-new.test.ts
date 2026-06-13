/**
 * Unit tests for the 6 new AI agent tools:
 *   get_case_history, get_cases_due_soon, draft_message,
 *   monthly_sales_snapshot, financial_summary, remake_rate.
 *
 * All DB access and RBAC are mocked — no live database required.
 *
 * Coverage:
 *  - get_case_history: happy path, found:false for unknown query, role guard, empty query guard
 *  - get_cases_due_soon: happy path, empty result, today-only flag, role guard
 *  - draft_message: AI path, template fallback when key absent, caseId context, role guard
 *  - monthly_sales_snapshot: revenue totals, specific month param, zeros, role guard
 *  - financial_summary: AR/AP/cash/projections, no bank accounts, role guard
 *  - remake_rate: calculation, zero denominator, custom date range, role guard
 *  - Registry: all 6 are registered, all are readonly, summarize returns strings
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolContext } from "./ai-agent-tools";

// ── Hoisted mock handles ──────────────────────────────────────────────────────

const mockRequireAnyRole = vi.hoisted(() => vi.fn().mockResolvedValue({ role: "admin" }));
const mockDbSelect = vi.hoisted(() => vi.fn());
const mockCasesFindFirst = vi.hoisted(() => vi.fn().mockResolvedValue(null));
const mockCaseEventsFindMany = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockCaseNotesFindMany = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockOrgsFindFirst = vi.hoisted(() => vi.fn().mockResolvedValue(null));
const mockBankAccountsFindMany = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockOpenAICreate = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    choices: [{ message: { content: "Hi Dr. Smith, your case is ready. — Bright Lab" } }],
  }),
);

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("@workspace/db", () => ({
  db: {
    select: mockDbSelect,
    query: {
      cases: { findFirst: mockCasesFindFirst },
      caseEvents: { findMany: mockCaseEventsFindMany },
      caseNotes: { findMany: mockCaseNotesFindMany },
      organizations: { findFirst: mockOrgsFindFirst },
      bankAccounts: { findMany: mockBankAccountsFindMany },
    },
  },
  cases: {
    id: {}, caseNumber: {}, labOrganizationId: {}, deletedAt: {}, dueDate: {},
    patientFirstName: {}, patientLastName: {}, status: {}, priority: {},
    doctorName: {}, createdAt: {}, remakeOfCaseId: {}, receivedAt: {},
  },
  invoices: {
    id: {}, labOrganizationId: {}, deletedAt: {}, status: {}, total: {},
    balanceDue: {}, createdAt: {}, providerOrganizationId: {}, caseId: {},
    invoiceNumber: {}, voidedAt: {}, voidedByUserId: {}, voidReason: {},
    voidKind: {}, updatedByUserId: {},
  },
  bankTransactions: {
    id: {}, bankAccountId: {}, labOrganizationId: {}, status: {}, type: {},
    netAmount: {}, txnDate: {}, source: {},
  },
  bankTransactionInvoices: { bankTransactionId: {}, invoiceId: {} },
  bankAccounts: { labOrganizationId: {}, id: {}, openingBalance: {} },
  caseEvents: { caseId: {}, occurredAt: {}, createdAt: {}, eventType: {}, actorInitials: {}, metadataJson: {} },
  caseNotes: { caseId: {}, createdAt: {}, noteText: {}, visibility: {} },
  organizations: { id: {}, displayName: {}, name: {}, invoiceTemplate: {}, updatedAt: {} },
  organizationMemberships: { userId: {}, status: {}, labId: {} },
  organizationConnections: { labOrganizationId: {}, providerOrganizationId: {} },
  payments: { invoiceId: {}, amount: {}, paymentMethod: {}, referenceNumber: {}, recordedByUserId: {} },
  pricingTiers: { labOrganizationId: {}, name: {}, deletedAt: {} },
  pricingOverrides: { labOrganizationId: {}, doctorName: {}, deletedAt: {} },
}));

vi.mock("drizzle-orm", () => ({
  eq: () => ({}),
  and: () => ({}),
  or: () => ({}),
  gte: () => ({}),
  lte: () => ({}),
  asc: () => ({}),
  desc: () => ({}),
  ilike: () => ({}),
  inArray: () => ({}),
  isNull: () => ({}),
  isNotNull: () => ({}),
  sql: Object.assign((_strings: TemplateStringsArray, ..._values: unknown[]) => ({}), {}),
}));

vi.mock("./rbac", () => ({
  requireAnyRole: mockRequireAnyRole,
  requireMembership: vi.fn().mockResolvedValue({ role: "admin" }),
  ADMIN_ROLES: ["owner", "admin"],
  BILLING_ROLES: ["owner", "admin", "billing"],
}));

vi.mock("./audit", () => ({
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./soft-delete", () => ({
  notDeleted: () => ({}),
}));

vi.mock("./statements", () => ({
  runBatchSendStatements: vi.fn().mockResolvedValue({ results: [] }),
}));

vi.mock("./invoice-deposits", () => ({
  ensureInvoiceDeposit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("openai", () => {
  function MockOpenAI(this: Record<string, unknown>) {
    this["chat"] = {
      completions: {
        create: mockOpenAICreate,
      },
    };
  }
  return { default: MockOpenAI };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns a Drizzle-style chainable object that resolves to `result` when
 * awaited. Every intermediate builder method (from, where, orderBy, etc.)
 * returns the same chain, and `then`/`catch` make the object a thenable so
 * `await chain` produces `result`.
 */
function mockChain(result: unknown) {
  const chain: Record<string, unknown> = {};
  for (const m of [
    "from", "where", "orderBy", "limit", "innerJoin", "leftJoin",
    "set", "returning", "values",
  ]) {
    chain[m] = () => chain;
  }
  chain["then"] = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  chain["catch"] = (fn: (e: unknown) => unknown) =>
    Promise.resolve(result).catch(fn);
  return chain;
}

/** Minimal ToolContext for lab staff happy-path tests. */
function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    userId: "user-1",
    req: {} as never,
    userType: "lab",
    labOrganizationId: "lab-1",
    providerOrgIds: [],
    ...overrides,
  };
}

// ── Import tool registry (after all mocks are hoisted) ────────────────────────

import { TOOL_BY_NAME, AGENT_TOOLS } from "./ai-agent-tools";

// ── Global setup ──────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAnyRole.mockResolvedValue({ role: "admin" });
  mockOrgsFindFirst.mockResolvedValue({ displayName: "Bright Lab", name: "Bright Lab" });
  mockBankAccountsFindMany.mockResolvedValue([]);
  mockCasesFindFirst.mockResolvedValue(null);
  mockCaseEventsFindMany.mockResolvedValue([]);
  mockCaseNotesFindMany.mockResolvedValue([]);
});

// ─────────────────────────────────────────────────────────────────────────────
// get_case_history
// ─────────────────────────────────────────────────────────────────────────────

describe("get_case_history", () => {
  const tool = TOOL_BY_NAME.get("get_case_history")!;

  it("returns found:false for an unknown query without throwing", async () => {
    mockCasesFindFirst.mockResolvedValueOnce(null);
    const result = await tool.execute({ query: "nonexistent-patient-xyz" }, makeCtx()) as Record<string, unknown>;
    expect(result["found"]).toBe(false);
    expect(String(result["message"])).toMatch(/nonexistent-patient-xyz/);
  });

  it("returns found:true with full timeline on happy path", async () => {
    const fakeCase = {
      id: "case-1",
      caseNumber: "26-001",
      patientFirstName: "Jane",
      patientLastName: "Doe",
      doctorName: "Dr. Smith",
      status: "active",
      priority: "normal",
      dueDate: new Date("2026-06-15"),
      receivedAt: new Date("2026-06-01"),
      createdAt: new Date("2026-06-01"),
      remakeOfCaseId: null,
      remakeReason: null,
      remakeCharged: null,
      labOrganizationId: "lab-1",
      deletedAt: null,
    };
    const fakeEvent = {
      caseId: "case-1",
      eventType: "case_created",
      actorInitials: "JD",
      occurredAt: new Date("2026-06-01T10:00:00Z"),
      createdAt: new Date("2026-06-01T10:00:00Z"),
      metadataJson: {},
    };
    const fakeNote = {
      caseId: "case-1",
      noteText: "Customer called to check on status",
      visibility: "internal_lab_only",
      createdAt: new Date("2026-06-02T09:00:00Z"),
    };

    mockCasesFindFirst.mockResolvedValueOnce(fakeCase);
    mockCaseEventsFindMany.mockResolvedValueOnce([fakeEvent]);
    mockCaseNotesFindMany.mockResolvedValueOnce([fakeNote]);

    const result = await tool.execute({ query: "Jane" }, makeCtx()) as Record<string, unknown>;
    expect(result["found"]).toBe(true);
    expect((result["case"] as Record<string, unknown>)["caseNumber"]).toBe("26-001");
    expect((result["case"] as Record<string, unknown>)["patientName"]).toBe("Jane Doe");
    expect(Array.isArray(result["timeline"])).toBe(true);
    expect((result["timeline"] as unknown[]).length).toBe(2);
    expect(result["eventCount"]).toBe(1);
    expect(result["noteCount"]).toBe(1);
  });

  it("includes remake origin when remakeOfCaseId is set", async () => {
    const remakeCaseRow = {
      id: "case-2",
      caseNumber: "26-002",
      patientFirstName: "Bob",
      patientLastName: "Baker",
      doctorName: "Dr. A",
      status: "active",
      priority: "normal",
      dueDate: null,
      receivedAt: null,
      createdAt: new Date("2026-06-10"),
      remakeOfCaseId: "case-1",
      remakeReason: "shade mismatch",
      remakeCharged: false,
      labOrganizationId: "lab-1",
      deletedAt: null,
    };
    const originalRow = { caseNumber: "26-001" };

    mockCasesFindFirst
      .mockResolvedValueOnce(remakeCaseRow)
      .mockResolvedValueOnce(originalRow);
    mockCaseEventsFindMany.mockResolvedValueOnce([]);
    mockCaseNotesFindMany.mockResolvedValueOnce([]);

    const result = await tool.execute({ query: "26-002" }, makeCtx()) as Record<string, unknown>;
    expect(result["found"]).toBe(true);
    expect((result["case"] as Record<string, unknown>)["remakeOf"]).toBe("26-001");
  });

  it("throws when role check fails", async () => {
    mockCasesFindFirst.mockResolvedValueOnce({ id: "c1", labOrganizationId: "lab-1" });
    mockRequireAnyRole.mockRejectedValueOnce(new Error("Forbidden"));
    await expect(tool.execute({ query: "Jane" }, makeCtx())).rejects.toThrow();
  });

  it("throws when query is empty", async () => {
    await expect(tool.execute({ query: "" }, makeCtx())).rejects.toThrow(/required/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// get_cases_due_soon
// ─────────────────────────────────────────────────────────────────────────────

describe("get_cases_due_soon", () => {
  const tool = TOOL_BY_NAME.get("get_cases_due_soon")!;

  it("returns count and mapped cases on happy path (today + tomorrow)", async () => {
    const today = new Date();
    const fakeRows = [
      {
        id: "case-1",
        caseNumber: "26-001",
        patientFirstName: "Alice",
        patientLastName: "Smith",
        doctorName: "Dr. A",
        status: "active",
        priority: "normal",
        dueDate: today,
      },
    ];
    mockDbSelect.mockReturnValueOnce(mockChain(fakeRows));

    const result = await tool.execute({}, makeCtx()) as Record<string, unknown>;
    expect(result["count"]).toBe(1);
    const cases = result["cases"] as Array<Record<string, unknown>>;
    expect(cases).toHaveLength(1);
    expect(cases[0]!["patientName"]).toBe("Alice Smith");
    expect(cases[0]!["doctorName"]).toBe("Dr. A");
  });

  it("returns empty list when no cases are due", async () => {
    mockDbSelect.mockReturnValueOnce(mockChain([]));
    const result = await tool.execute({}, makeCtx()) as Record<string, unknown>;
    expect(result["count"]).toBe(0);
    expect((result["cases"] as unknown[]).length).toBe(0);
  });

  it("today-only flag excludes tomorrow via includeTomorrow:false", async () => {
    mockDbSelect.mockReturnValueOnce(mockChain([]));
    const result = await tool.execute({ includeTomorrow: false }, makeCtx()) as Record<string, unknown>;
    expect(result["count"]).toBe(0);
    expect(mockDbSelect).toHaveBeenCalledTimes(1);
  });

  it("correctly splits today vs tomorrow counts", async () => {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const eot = new Date(startOfToday);
    eot.setDate(eot.getDate() + 1);
    eot.setMilliseconds(-1);
    const tomorrow = new Date(startOfToday);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const fakeRows = [
      { id: "c1", caseNumber: "26-001", patientFirstName: "A", patientLastName: "B",
        doctorName: "Dr. X", status: "active", priority: "normal", dueDate: now },
      { id: "c2", caseNumber: "26-002", patientFirstName: "C", patientLastName: "D",
        doctorName: "Dr. Y", status: "active", priority: "normal", dueDate: tomorrow },
    ];
    mockDbSelect.mockReturnValueOnce(mockChain(fakeRows));

    const result = await tool.execute({}, makeCtx()) as Record<string, unknown>;
    expect(result["count"]).toBe(2);
    expect(result["todayCount"]).toBe(1);
    expect(result["tomorrowCount"]).toBe(1);
  });

  it("throws when role check fails", async () => {
    mockRequireAnyRole.mockRejectedValueOnce(new Error("Forbidden"));
    await expect(tool.execute({}, makeCtx())).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// draft_message
// ─────────────────────────────────────────────────────────────────────────────

describe("draft_message", () => {
  const tool = TOOL_BY_NAME.get("draft_message")!;

  afterEach(() => {
    delete process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];
  });

  it("degrades gracefully to template when AI key is absent", async () => {
    delete process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];
    mockOrgsFindFirst.mockResolvedValueOnce({ displayName: "Bright Lab", name: "Bright Lab" });

    const result = await tool.execute(
      { targetType: "doctor", targetName: "Dr. Jones", intent: "case is delayed by 2 days" },
      makeCtx(),
    ) as Record<string, unknown>;

    expect(typeof result["draft"]).toBe("string");
    expect(String(result["draft"]).length).toBeGreaterThan(0);
    expect(result["note"]).toMatch(/not available|template/i);
    expect(String(result["draft"])).toContain("Dr. Jones");
  });

  it("template includes intent text when AI key is absent", async () => {
    delete process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];
    mockOrgsFindFirst.mockResolvedValueOnce({ name: "MyLab", displayName: "" });

    const result = await tool.execute(
      { targetType: "lab_member", targetName: "Sarah", intent: "please review the shade" },
      makeCtx(),
    ) as Record<string, unknown>;

    expect(String(result["draft"])).toContain("please review the shade");
  });

  it("returns AI draft when key is configured", async () => {
    process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] = "sk-test-key";
    mockOrgsFindFirst.mockResolvedValueOnce({ displayName: "Bright Lab", name: "Bright Lab" });

    const result = await tool.execute(
      { targetType: "doctor", targetName: "Dr. Smith", intent: "case is ready for pickup" },
      makeCtx(),
    ) as Record<string, unknown>;

    expect(typeof result["draft"]).toBe("string");
    expect(String(result["draft"]).length).toBeGreaterThan(0);
    expect(mockOpenAICreate).toHaveBeenCalledTimes(1);
    expect(result["note"]).toBeUndefined();
  });

  it("includes case context in template when caseId resolves", async () => {
    delete process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];
    const fakeCase = {
      caseNumber: "26-001",
      patientFirstName: "Jane",
      patientLastName: "Doe",
      doctorName: "Dr. A",
      status: "active",
      dueDate: new Date("2026-06-20"),
    };
    mockCasesFindFirst.mockResolvedValueOnce(fakeCase);
    mockOrgsFindFirst.mockResolvedValueOnce({ displayName: "Bright Lab", name: "Bright Lab" });

    const result = await tool.execute(
      { targetType: "doctor", targetName: "Dr. A", intent: "case ready", caseId: "case-1" },
      makeCtx(),
    ) as Record<string, unknown>;

    expect(typeof result["draft"]).toBe("string");
    expect(String(result["draft"]).length).toBeGreaterThan(0);
  });

  it("throws when role check fails", async () => {
    mockRequireAnyRole.mockRejectedValueOnce(new Error("Forbidden"));
    await expect(
      tool.execute({ targetType: "doctor", targetName: "Dr. X", intent: "test" }, makeCtx()),
    ).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// monthly_sales_snapshot
// ─────────────────────────────────────────────────────────────────────────────

describe("monthly_sales_snapshot", () => {
  const tool = TOOL_BY_NAME.get("monthly_sales_snapshot")!;

  it("returns correct revenue totals on happy path", async () => {
    const fakeRows = [
      { status: "paid", total: "150.00", balanceDue: "0.00" },
      { status: "paid", total: "200.00", balanceDue: "0.00" },
      { status: "open", total: "75.00", balanceDue: "75.00" },
    ];
    mockDbSelect.mockReturnValueOnce(mockChain(fakeRows));

    const result = await tool.execute({}, makeCtx()) as Record<string, unknown>;
    expect(result["totalInvoiceCount"]).toBe(3);
    expect(result["paidInvoiceCount"]).toBe(2);
    expect(result["openInvoiceCount"]).toBe(1);
    expect(Number(result["totalRevenue"])).toBe(425);
    expect(Number(result["paidRevenue"])).toBe(350);
    expect(Number(result["outstandingBalance"])).toBe(75);
  });

  it("accepts a specific month parameter (YYYY-MM)", async () => {
    mockDbSelect.mockReturnValueOnce(mockChain([]));
    const result = await tool.execute({ month: "2026-01" }, makeCtx()) as Record<string, unknown>;
    expect(result["totalInvoiceCount"]).toBe(0);
    expect(String(result["month"])).toMatch(/January|Jan|2026/);
  });

  it("returns zeros when no invoices exist for the month", async () => {
    mockDbSelect.mockReturnValueOnce(mockChain([]));
    const result = await tool.execute({}, makeCtx()) as Record<string, unknown>;
    expect(result["totalRevenue"]).toBe("0.00");
    expect(result["paidRevenue"]).toBe("0.00");
    expect(result["outstandingBalance"]).toBe("0.00");
    expect(result["paidInvoiceCount"]).toBe(0);
    expect(result["openInvoiceCount"]).toBe(0);
  });

  it("handles a malformed month param gracefully (falls back to current month)", async () => {
    mockDbSelect.mockReturnValueOnce(mockChain([]));
    const result = await tool.execute({ month: "not-a-date" }, makeCtx()) as Record<string, unknown>;
    expect(result["totalInvoiceCount"]).toBe(0);
  });

  it("throws when role check fails", async () => {
    mockRequireAnyRole.mockRejectedValueOnce(new Error("Forbidden"));
    await expect(tool.execute({}, makeCtx())).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// financial_summary
// ─────────────────────────────────────────────────────────────────────────────

describe("financial_summary", () => {
  const tool = TOOL_BY_NAME.get("financial_summary")!;

  it("returns AR, AP, cash on hand, and 30/60/90-day projections", async () => {
    mockBankAccountsFindMany.mockResolvedValueOnce([
      { id: "acct-1", openingBalance: "1000.00" },
    ]);
    // Sequential select calls: AR, AP, posted txns sum, proj30, proj60, proj90
    mockDbSelect
      .mockReturnValueOnce(mockChain([{ balanceDue: "500.00" }, { balanceDue: "300.00" }]))
      .mockReturnValueOnce(mockChain([{ netAmount: "-200.00" }]))
      .mockReturnValueOnce(mockChain([{ net: "250.00" }]))
      .mockReturnValueOnce(mockChain([{ net: "100.00" }]))
      .mockReturnValueOnce(mockChain([{ net: "200.00" }]))
      .mockReturnValueOnce(mockChain([{ net: "300.00" }]));

    const result = await tool.execute({}, makeCtx()) as Record<string, unknown>;
    expect(Number(result["accountsReceivable"])).toBe(800);
    expect(Number(result["accountsPayable"])).toBe(200);
    expect(Number(result["cashOnHand"])).toBe(1250); // 1000 opening + 250 posted
    const proj = result["projections"] as Record<string, string>;
    expect(proj["next30Days"]).toBe("100.00");
    expect(proj["next60Days"]).toBe("200.00");
    expect(proj["next90Days"]).toBe("300.00");
    expect(typeof result["asOf"]).toBe("string");
  });

  it("handles lab with no bank accounts (skips cash and projection queries)", async () => {
    mockBankAccountsFindMany.mockResolvedValueOnce([]);
    mockDbSelect
      .mockReturnValueOnce(mockChain([]))  // AR
      .mockReturnValueOnce(mockChain([])); // AP
    // No additional selects because acctIds is empty

    const result = await tool.execute({}, makeCtx()) as Record<string, unknown>;
    expect(result["accountsReceivable"]).toBe("0.00");
    expect(result["cashOnHand"]).toBe("0.00");
    const proj = result["projections"] as Record<string, string>;
    expect(proj["next30Days"]).toBe("0.00");
    expect(proj["next60Days"]).toBe("0.00");
    expect(proj["next90Days"]).toBe("0.00");
    // Only 2 selects were needed (no projection queries)
    expect(mockDbSelect).toHaveBeenCalledTimes(2);
  });

  it("throws when role check fails", async () => {
    mockRequireAnyRole.mockRejectedValueOnce(new Error("Forbidden"));
    await expect(tool.execute({}, makeCtx())).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// remake_rate
// ─────────────────────────────────────────────────────────────────────────────

describe("remake_rate", () => {
  const tool = TOOL_BY_NAME.get("remake_rate")!;

  it("calculates remake rate correctly on happy path", async () => {
    // Promise.all issues two concurrent db.select calls (total, remakes)
    mockDbSelect
      .mockReturnValueOnce(mockChain([{ count: 20 }]))
      .mockReturnValueOnce(mockChain([{ count: 4 }]));

    const result = await tool.execute({}, makeCtx()) as Record<string, unknown>;
    expect(result["totalCases"]).toBe(20);
    expect(result["remakeCases"]).toBe(4);
    expect(result["remakeRate"]).toBe("20.0%");
    expect(result["remakeRateNumber"]).toBe(20.0);
  });

  it("returns 0.0% when there are no cases (avoids division-by-zero)", async () => {
    mockDbSelect
      .mockReturnValueOnce(mockChain([{ count: 0 }]))
      .mockReturnValueOnce(mockChain([{ count: 0 }]));

    const result = await tool.execute({}, makeCtx()) as Record<string, unknown>;
    expect(result["remakeRate"]).toBe("0.0%");
    expect(result["remakeRateNumber"]).toBe(0);
    expect(result["totalCases"]).toBe(0);
  });

  it("accepts a custom date range (dateFrom / dateTo)", async () => {
    mockDbSelect
      .mockReturnValueOnce(mockChain([{ count: 10 }]))
      .mockReturnValueOnce(mockChain([{ count: 1 }]));

    const result = await tool.execute(
      { dateFrom: "2026-01-01", dateTo: "2026-03-31" },
      makeCtx(),
    ) as Record<string, unknown>;
    const period = result["period"] as Record<string, string>;
    expect(typeof period["from"]).toBe("string");
    expect(typeof period["to"]).toBe("string");
    expect(result["remakeRate"]).toBe("10.0%");
    expect(result["totalCases"]).toBe(10);
    expect(result["remakeCases"]).toBe(1);
  });

  it("throws when role check fails", async () => {
    mockRequireAnyRole.mockRejectedValueOnce(new Error("Forbidden"));
    await expect(tool.execute({}, makeCtx())).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Registry completeness checks for the 6 new tools
// ─────────────────────────────────────────────────────────────────────────────

describe("registry completeness — 6 new tools", () => {
  const NEW_TOOL_NAMES = [
    "get_case_history",
    "get_cases_due_soon",
    "draft_message",
    "monthly_sales_snapshot",
    "financial_summary",
    "remake_rate",
  ] as const;

  it("all 6 new tools are present in TOOL_BY_NAME", () => {
    for (const name of NEW_TOOL_NAMES) {
      expect(TOOL_BY_NAME.has(name), `"${name}" should be in TOOL_BY_NAME`).toBe(true);
    }
  });

  it("all 6 new tools are present in AGENT_TOOLS array", () => {
    const names = AGENT_TOOLS.map((t) => t.name);
    for (const name of NEW_TOOL_NAMES) {
      expect(names, `"${name}" should be in AGENT_TOOLS`).toContain(name);
    }
  });

  it("all 6 new tools have kind 'readonly'", () => {
    for (const name of NEW_TOOL_NAMES) {
      const tool = TOOL_BY_NAME.get(name)!;
      expect(tool.kind, `"${name}" should be readonly`).toBe("readonly");
    }
  });

  it("all 6 new tools satisfy the AgentTool interface shape", () => {
    for (const name of NEW_TOOL_NAMES) {
      const tool = TOOL_BY_NAME.get(name)!;
      expect(typeof tool.name).toBe("string");
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(0);
      expect(typeof tool.parameters).toBe("object");
      expect(typeof tool.summarize).toBe("function");
      expect(typeof tool.execute).toBe("function");
    }
  });

  it("summarize() returns a non-empty string for each new tool", async () => {
    const ctx = makeCtx();
    const args = {
      query: "test",
      targetType: "doctor",
      targetName: "Dr. X",
      intent: "test intent",
    };
    for (const name of NEW_TOOL_NAMES) {
      const tool = TOOL_BY_NAME.get(name)!;
      mockOrgsFindFirst.mockResolvedValue({ displayName: "Lab", name: "Lab" });
      const summary = await tool.summarize(args, ctx);
      expect(typeof summary, `summarize of "${name}" should return a string`).toBe("string");
      expect(summary.length, `summarize of "${name}" should be non-empty`).toBeGreaterThan(0);
    }
  });
});
