/**
 * Unit tests for the two key scheduler behaviours introduced alongside the
 * statement-schedule feature:
 *
 *  1. processDueSchedules — dayOfMonth=0 fires on the true last calendar day
 *     of the month (Feb 28/29, Apr 30, Dec 31) and not one day earlier.
 *
 *  2. buildPracticeStatements — a non-empty includedOrgIds list filters out
 *     practices whose id is not in the list; null / empty → no filter.
 *
 * Both functions hit the DB, so @workspace/db and drizzle-orm operators are
 * fully mocked here — the tests exercise only the scheduling and filtering
 * logic, not SQL generation or real data access.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoist the mock handles so the vi.mock factories can close over them.
// ---------------------------------------------------------------------------

const mockFindManySchedules = vi.hoisted(() => vi.fn());
const mockFindManyInvoices = vi.hoisted(() => vi.fn());
const mockSelectWhereOrgs = vi.hoisted(() => vi.fn());

// Tracks every call to db.update() so tests can assert "did the scheduler
// attempt to claim the schedule?" (i.e. did it reach the DB update step).
const mockUpdateReturning = vi.hoisted(() => vi.fn());

// ---------------------------------------------------------------------------
// Mock @workspace/db — replace the live Drizzle client with a stub.
// The schema table exports are plain objects; real column refs are never
// traversed because drizzle-orm operators are also mocked below.
// ---------------------------------------------------------------------------

vi.mock("@workspace/db", () => {
  const selectChain = {
    from: vi.fn().mockReturnValue({
      where: mockSelectWhereOrgs,
    }),
  };

  const whereChain = {
    returning: mockUpdateReturning,
    catch: vi.fn().mockResolvedValue(undefined),
  };

  const setChain = {
    where: vi.fn().mockReturnValue(whereChain),
  };

  const db = {
    query: {
      statementSchedules: { findMany: mockFindManySchedules },
      organizations: { findFirst: vi.fn().mockResolvedValue(null) },
      invoices: { findMany: mockFindManyInvoices },
      invoiceLineItems: { findMany: vi.fn().mockResolvedValue([]) },
    },
    update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue(setChain) }),
    select: vi.fn().mockReturnValue(selectChain),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    }),
  };

  return {
    db,
    invoices: { labOrganizationId: {}, createdAt: {}, providerOrganizationId: {} },
    invoiceLineItems: { invoiceId: {}, sortOrder: {} },
    organizations: { id: {}, name: {}, displayName: {}, billingEmail: {} },
    statementSchedules: {
      id: {},
      enabled: {},
      labOrganizationId: {},
      dayOfMonth: {},
      lastSentForMonth: {},
      inProgressForMonth: {},
      inProgressLeasedAt: {},
    },
    statementSendRuns: {
      id: {},
      status: {},
      attemptCount: {},
      nextAttemptAt: {},
      labOrganizationId: {},
    },
  };
});

// ---------------------------------------------------------------------------
// Mock drizzle-orm operators so they never touch real column metadata.
// The mock db ignores WHERE/ORDER arguments — they just need to not throw.
// ---------------------------------------------------------------------------

vi.mock("drizzle-orm", () => ({
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

function makeSchedule(overrides: Record<string, unknown> = {}) {
  return {
    id: "sched-1",
    labOrganizationId: "lab-1",
    enabled: true,
    dayOfMonth: 1,
    lastSentForMonth: null,
    inProgressForMonth: null,
    inProgressLeasedAt: null,
    includedOrgIds: null,
    emailSubject: null,
    emailBody: null,
    emailReplyTo: null,
    ...overrides,
  };
}

function makeInvoice(providerOrganizationId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `inv-${providerOrganizationId}`,
    labOrganizationId: "lab-1",
    providerOrganizationId,
    invoiceNumber: `INV-${providerOrganizationId}`,
    status: "sent",
    total: "100.00",
    balanceDue: "0.00",
    createdAt: new Date("2025-04-15T00:00:00Z"),
    issuedAt: new Date("2025-04-15T00:00:00Z"),
    dueAt: null,
    displayMetadataJson: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// processDueSchedules — dayOfMonth = 0 (last-day-of-month semantics)
// ---------------------------------------------------------------------------

describe("processDueSchedules — dayOfMonth=0 last-day-of-month", () => {
  // Import lazily so vi.mock factories are in effect first.
  let processDueSchedules: (asOf?: Date) => Promise<void>;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Default: update().set().where().returning() → [] (not claimed).
    // This prevents runMonthlyStatementsForLab from being invoked and keeps
    // the tests focused purely on the "should we attempt to fire?" check.
    mockUpdateReturning.mockResolvedValue([]);
    ({ processDueSchedules } = await import("./statements.js"));
  });

  it("fires on Feb 28 of a non-leap year", async () => {
    mockFindManySchedules.mockResolvedValue([makeSchedule({ dayOfMonth: 0 })]);

    // 28 Feb 2023 is the last day of February in a non-leap year.
    await processDueSchedules(new Date("2023-02-28T12:00:00Z"));

    const { db } = await import("@workspace/db");
    expect(db.update).toHaveBeenCalled();
  });

  it("does NOT fire on Feb 27 of a non-leap year", async () => {
    mockFindManySchedules.mockResolvedValue([makeSchedule({ dayOfMonth: 0 })]);

    await processDueSchedules(new Date("2023-02-27T12:00:00Z"));

    const { db } = await import("@workspace/db");
    expect(db.update).not.toHaveBeenCalled();
  });

  it("fires on Feb 29 of a leap year", async () => {
    mockFindManySchedules.mockResolvedValue([makeSchedule({ dayOfMonth: 0 })]);

    // 29 Feb 2024 is the last day of February in a leap year.
    await processDueSchedules(new Date("2024-02-29T12:00:00Z"));

    const { db } = await import("@workspace/db");
    expect(db.update).toHaveBeenCalled();
  });

  it("does NOT fire on Feb 28 of a leap year", async () => {
    mockFindManySchedules.mockResolvedValue([makeSchedule({ dayOfMonth: 0 })]);

    // Feb 28 is NOT the last day in a leap year — Feb 29 is.
    await processDueSchedules(new Date("2024-02-28T12:00:00Z"));

    const { db } = await import("@workspace/db");
    expect(db.update).not.toHaveBeenCalled();
  });

  it("fires on Apr 30", async () => {
    mockFindManySchedules.mockResolvedValue([makeSchedule({ dayOfMonth: 0 })]);

    await processDueSchedules(new Date("2025-04-30T12:00:00Z"));

    const { db } = await import("@workspace/db");
    expect(db.update).toHaveBeenCalled();
  });

  it("does NOT fire on Apr 29", async () => {
    mockFindManySchedules.mockResolvedValue([makeSchedule({ dayOfMonth: 0 })]);

    await processDueSchedules(new Date("2025-04-29T12:00:00Z"));

    const { db } = await import("@workspace/db");
    expect(db.update).not.toHaveBeenCalled();
  });

  it("fires on Dec 31", async () => {
    mockFindManySchedules.mockResolvedValue([makeSchedule({ dayOfMonth: 0 })]);

    await processDueSchedules(new Date("2025-12-31T12:00:00Z"));

    const { db } = await import("@workspace/db");
    expect(db.update).toHaveBeenCalled();
  });

  it("does NOT fire on Dec 30", async () => {
    mockFindManySchedules.mockResolvedValue([makeSchedule({ dayOfMonth: 0 })]);

    await processDueSchedules(new Date("2025-12-30T12:00:00Z"));

    const { db } = await import("@workspace/db");
    expect(db.update).not.toHaveBeenCalled();
  });

  it("skips a schedule whose lastSentForMonth already matches the prior month", async () => {
    // Firing date: Jan 31. Prior month for Jan is December 2024 = "2024-12".
    mockFindManySchedules.mockResolvedValue([
      makeSchedule({ dayOfMonth: 0, lastSentForMonth: "2024-12" }),
    ]);

    await processDueSchedules(new Date("2025-01-31T12:00:00Z"));

    const { db } = await import("@workspace/db");
    // Guard check: dayOfMonth=0 on Jan 31 would fire (todayDay === lastDay),
    // but lastSentForMonth already equals the prior periodMonth, so it must be skipped.
    expect(db.update).not.toHaveBeenCalled();
  });

  it("catch-up: fires when asOf is after the target day (day 31 schedule, Feb 28 non-leap)", async () => {
    // dayOfMonth=31 should be clamped to 28 in February. Running on the 28th fires.
    mockFindManySchedules.mockResolvedValue([makeSchedule({ dayOfMonth: 31 })]);

    await processDueSchedules(new Date("2023-02-28T12:00:00Z"));

    const { db } = await import("@workspace/db");
    expect(db.update).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// buildPracticeStatements — includedOrgIds practice filter
// ---------------------------------------------------------------------------

describe("buildPracticeStatements — includedOrgIds filter", () => {
  let buildPracticeStatements: (
    labOrganizationId: string,
    periodStart: Date,
    periodEnd: Date,
    includedOrgIds?: string[] | null
  ) => Promise<import("./statements.js").PracticeStatementData[]>;

  const periodStart = new Date("2025-04-01T00:00:00Z");
  const periodEnd = new Date("2025-05-01T00:00:00Z");

  function makeOrg(id: string, name: string) {
    return { id, name, displayName: name, billingEmail: `${id}@example.com` };
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ buildPracticeStatements } = await import("./statements.js"));
  });

  it("returns all practices when includedOrgIds is null", async () => {
    mockFindManyInvoices.mockResolvedValue([
      makeInvoice("org-a"),
      makeInvoice("org-b"),
      makeInvoice("org-c"),
    ]);
    mockSelectWhereOrgs.mockResolvedValue([
      makeOrg("org-a", "Practice A"),
      makeOrg("org-b", "Practice B"),
      makeOrg("org-c", "Practice C"),
    ]);

    const result = await buildPracticeStatements("lab-1", periodStart, periodEnd, null);

    const ids = result.map((r) => r.practiceId).sort();
    expect(ids).toEqual(["org-a", "org-b", "org-c"]);
  });

  it("returns all practices when includedOrgIds is undefined", async () => {
    mockFindManyInvoices.mockResolvedValue([
      makeInvoice("org-a"),
      makeInvoice("org-b"),
    ]);
    mockSelectWhereOrgs.mockResolvedValue([
      makeOrg("org-a", "Practice A"),
      makeOrg("org-b", "Practice B"),
    ]);

    const result = await buildPracticeStatements("lab-1", periodStart, periodEnd);

    const ids = result.map((r) => r.practiceId).sort();
    expect(ids).toEqual(["org-a", "org-b"]);
  });

  it("returns all practices when includedOrgIds is an empty array", async () => {
    mockFindManyInvoices.mockResolvedValue([
      makeInvoice("org-a"),
      makeInvoice("org-b"),
    ]);
    mockSelectWhereOrgs.mockResolvedValue([
      makeOrg("org-a", "Practice A"),
      makeOrg("org-b", "Practice B"),
    ]);

    const result = await buildPracticeStatements("lab-1", periodStart, periodEnd, []);

    const ids = result.map((r) => r.practiceId).sort();
    expect(ids).toEqual(["org-a", "org-b"]);
  });

  it("filters to only the listed practices when includedOrgIds is non-empty", async () => {
    mockFindManyInvoices.mockResolvedValue([
      makeInvoice("org-a"),
      makeInvoice("org-b"),
      makeInvoice("org-c"),
    ]);
    mockSelectWhereOrgs.mockResolvedValue([
      makeOrg("org-a", "Practice A"),
      makeOrg("org-b", "Practice B"),
    ]);

    const result = await buildPracticeStatements(
      "lab-1",
      periodStart,
      periodEnd,
      ["org-a", "org-b"]
    );

    const ids = result.map((r) => r.practiceId).sort();
    expect(ids).toEqual(["org-a", "org-b"]);
    expect(ids).not.toContain("org-c");
  });

  it("excludes all practices when none match the includedOrgIds list", async () => {
    mockFindManyInvoices.mockResolvedValue([
      makeInvoice("org-a"),
      makeInvoice("org-b"),
    ]);
    mockSelectWhereOrgs.mockResolvedValue([]);

    const result = await buildPracticeStatements(
      "lab-1",
      periodStart,
      periodEnd,
      ["org-x", "org-y"]
    );

    expect(result).toHaveLength(0);
  });

  it("returns an empty array when there are no invoices in the period", async () => {
    mockFindManyInvoices.mockResolvedValue([]);

    const result = await buildPracticeStatements(
      "lab-1",
      periodStart,
      periodEnd,
      ["org-a"]
    );

    expect(result).toHaveLength(0);
  });

  it("aggregates multiple invoices for the same practice", async () => {
    mockFindManyInvoices.mockResolvedValue([
      makeInvoice("org-a", { invoiceNumber: "INV-001", total: "200.00", balanceDue: "50.00" }),
      makeInvoice("org-a", { id: "inv-org-a-2", invoiceNumber: "INV-002", total: "150.00", balanceDue: "0.00" }),
    ]);
    mockSelectWhereOrgs.mockResolvedValue([makeOrg("org-a", "Practice A")]);

    const result = await buildPracticeStatements("lab-1", periodStart, periodEnd, ["org-a"]);

    expect(result).toHaveLength(1);
    expect(result[0]!.invoiceCount).toBe(2);
    expect(result[0]!.totalBilled).toBeCloseTo(350);
    expect(result[0]!.totalPaid).toBeCloseTo(300);
  });
});
