/**
 * Integration tests for the custom date-range filter on GET /api/invoices.
 *
 * Background: the filter was silently dropping invoices without a `dueAt`
 * date because it keyed on `dueAt` instead of `issuedAt ?? createdAt`.
 * The fix changes the comparison date to `issuedAt ?? createdAt`.
 *
 * Coverage:
 *  - Invoices with no `dueAt` but an `issuedAt` within the range are included.
 *  - Invoices with neither `dueAt` nor `issuedAt` fall back to `createdAt`.
 *  - Invoices whose effective date falls outside the window are excluded.
 *  - Non-admin callers are not filtered by the custom range (no-op).
 *  - Overdue-bucket options (0_30, 31_60, 61_90, 90_plus) are unaffected
 *    by the fix and continue to use `dueAt` for age calculations.
 *
 * Skipped when DATABASE_URL is not configured.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { inArray } from "drizzle-orm";
import request from "supertest";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

/** Midnight UTC on a calendar date string like "2024-01-15". */
function utcMidnight(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00.000Z`);
}

/** daysAgo(n) returns a Date exactly n×24h before now. */
function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

maybe("GET /api/invoices – custom date-range filter (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let auth: typeof import("../lib/auth.js");

  const labOrgId = rid("lab");
  const providerOrgId = rid("prov");
  const adminUserId = rid("uadmin");
  const staffUserId = rid("ustaff");

  const tokens: { admin: string; staff: string } = { admin: "", staff: "" };

  // Track inserted invoice ids so afterAll can clean them up.
  const insertedInvoiceIds: string[] = [];

  async function makeSession(userId: string): Promise<string> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const token = auth.signAccessToken(userId, sessionId);
    const hash = createHash("sha256").update(token).digest("hex");
    await db.insert(userSessions).values({
      id: sessionId,
      userId,
      tokenHash: hash,
      expiresAt,
    });
    return token;
  }

  async function insertInvoice(opts: {
    issuedAt?: Date | null;
    dueAt?: Date | null;
    createdAt?: Date;
    balanceDue?: string;
    frozen?: boolean;
  }): Promise<string> {
    const { db, invoices } = dbMod as any;
    const id = rid("inv");
    await db.insert(invoices).values({
      id,
      invoiceNumber: rid("INV"),
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      status: "open",
      total: opts.balanceDue ?? "100.00",
      balanceDue: opts.balanceDue ?? "100.00",
      frozen: opts.frozen ?? false,
      createdByUserId: adminUserId,
      ...(opts.issuedAt !== undefined ? { issuedAt: opts.issuedAt } : {}),
      ...(opts.dueAt !== undefined ? { dueAt: opts.dueAt } : {}),
      ...(opts.createdAt !== undefined ? { createdAt: opts.createdAt } : {}),
    });
    insertedInvoiceIds.push(id);
    return id;
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-date-filter";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    auth = await import("../lib/auth.js");

    const { db, users, organizations, organizationMemberships } = dbMod as any;

    await db.insert(users).values([
      { id: adminUserId, username: `admin_${adminUserId}`, password: "x" },
      { id: staffUserId, username: `staff_${staffUserId}`, password: "x" },
    ]);

    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: rid("DateFilterLab") },
      {
        id: providerOrgId,
        type: "provider",
        name: rid("DateFilterPractice"),
        parentLabOrganizationId: labOrgId,
      },
    ]);

    await db.insert(organizationMemberships).values([
      // admin user: admin role → callerIsAdminOrOwner = true
      {
        id: rid("m"),
        labId: labOrgId,
        userId: adminUserId,
        role: "admin",
        status: "active",
      },
      // staff user: staff role → callerIsAdminOrOwner = false
      {
        id: rid("m"),
        labId: labOrgId,
        userId: staffUserId,
        role: "staff",
        status: "active",
      },
    ]);

    tokens.admin = await makeSession(adminUserId);
    tokens.staff = await makeSession(staffUserId);
  }, 60_000);

  beforeEach(async () => {
    tokens.admin = await makeSession(adminUserId);
    tokens.staff = await makeSession(staffUserId);
  });

  it.each([
    { param: "dateFrom" },
    { param: "dateTo" },
    { param: "issuedFrom" },
    { param: "issuedTo" },
    { param: "dueDateFrom" },
    { param: "dueDateTo" },
  ])("returns 400 for malformed $param", async ({ param }) => {
    const res = await request(appMod.default)
      .get("/api/invoices")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .query({ [param]: "not-a-date" });

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.message).toContain(param);
  });

  it("rejects impossible ISO calendar dates", async () => {
    const res = await request(appMod.default)
      .get("/api/invoices")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .query({ dateFrom: "2024-02-31" });

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.message).toContain("dateFrom");
  });

  it.each([
    { from: "dateFrom", to: "dateTo" },
    { from: "issuedFrom", to: "issuedTo" },
    { from: "dueDateFrom", to: "dueDateTo" },
  ])("returns 400 when $from is after $to", async ({ from, to }) => {
    const res = await request(appMod.default)
      .get("/api/invoices")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .query({
        [from]: "2024-02-01",
        [to]: "2024-01-01",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.message).toContain(`${from} must be on or before ${to}`);
  });

  it("continues to accept ISO date and timestamp filter values", async () => {
    const res = await request(appMod.default)
      .get("/api/invoices")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .query({
        dateFrom: "2024-01-01T00:00:00.000Z",
        dateTo: "2024-01-31T23:59:59.999Z",
        issuedFrom: "2024-01-01T00:00:00.000Z",
        issuedTo: "2024-02-01T00:00:00.000Z",
        dueDateFrom: "2024-01-01",
        dueDateTo: "2024-01-31",
        overdueBucket: "custom",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const {
      db,
      invoices,
      organizations,
      users,
      organizationMemberships,
      userSessions,
      auditLogs,
    } = dbMod as any;

    if (insertedInvoiceIds.length) {
      await db
        .delete(invoices)
        .where(inArray(invoices.id, insertedInvoiceIds));
    }
    await db
      .delete(auditLogs)
      .where(inArray(auditLogs.organizationId, [labOrgId]));
    await db
      .delete(organizationMemberships)
      .where(inArray(organizationMemberships.userId, [adminUserId, staffUserId]));
    await db
      .delete(userSessions)
      .where(inArray(userSessions.userId, [adminUserId, staffUserId]));
    await db
      .delete(organizations)
      .where(inArray(organizations.id, [labOrgId, providerOrgId]));
    await db
      .delete(users)
      .where(inArray(users.id, [adminUserId, staffUserId]));
  });

  // ---------------------------------------------------------------------------
  // custom overdueBucket filter
  // ---------------------------------------------------------------------------

  it("includes invoice with issuedAt in range when dueAt is null", async () => {
    const inRange = await insertInvoice({
      issuedAt: utcMidnight("2024-01-15"),
      dueAt: null,
    });
    const outOfRange = await insertInvoice({
      issuedAt: utcMidnight("2023-11-01"),
      dueAt: null,
    });

    const res = await request(appMod.default)
      .get("/api/invoices")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .query({
        overdueBucket: "custom",
        dueDateFrom: "2024-01-01",
        dueDateTo: "2024-01-31",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const ids: string[] = res.body.data.map((r: any) => r.id);
    expect(ids).toContain(inRange);
    expect(ids).not.toContain(outOfRange);
  });

  it("includes invoice via createdAt fallback when both issuedAt and dueAt are null", async () => {
    const inRange = await insertInvoice({
      issuedAt: null,
      dueAt: null,
      createdAt: utcMidnight("2024-01-20"),
    });
    const outOfRange = await insertInvoice({
      issuedAt: null,
      dueAt: null,
      createdAt: utcMidnight("2023-10-05"),
    });

    const res = await request(appMod.default)
      .get("/api/invoices")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .query({
        overdueBucket: "custom",
        dueDateFrom: "2024-01-01",
        dueDateTo: "2024-01-31",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const ids: string[] = res.body.data.map((r: any) => r.id);
    expect(ids).toContain(inRange);
    expect(ids).not.toContain(outOfRange);
  });

  it("excludes invoice whose issuedAt falls outside the window", async () => {
    const tooEarly = await insertInvoice({
      issuedAt: utcMidnight("2023-12-31"),
    });
    const tooLate = await insertInvoice({
      issuedAt: utcMidnight("2024-02-01"),
    });

    const res = await request(appMod.default)
      .get("/api/invoices")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .query({
        overdueBucket: "custom",
        dueDateFrom: "2024-01-01",
        dueDateTo: "2024-01-31",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const ids: string[] = res.body.data.map((r: any) => r.id);
    expect(ids).not.toContain(tooEarly);
    expect(ids).not.toContain(tooLate);
  });

  it("does not apply the custom filter for non-admin callers (staff role)", async () => {
    // This invoice's issuedAt is outside any narrow range, but a staff caller
    // should get it back unfiltered (callerIsAdminOrOwner = false → filter skipped).
    const anInvoice = await insertInvoice({
      issuedAt: utcMidnight("2022-06-01"),
    });

    const res = await request(appMod.default)
      .get("/api/invoices")
      .set("Authorization", `Bearer ${tokens.staff}`)
      .query({
        overdueBucket: "custom",
        dueDateFrom: "2024-01-01",
        dueDateTo: "2024-01-31",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const ids: string[] = res.body.data.map((r: any) => r.id);
    // Staff caller: filter is a no-op, so the invoice is visible regardless of date.
    expect(ids).toContain(anInvoice);
  });

  // ---------------------------------------------------------------------------
  // Overdue bucket filter — unaffected by the fix (still uses dueAt for age)
  // ---------------------------------------------------------------------------

  it("0_30 bucket returns only invoices whose dueAt is 0–30 days overdue", async () => {
    const inBucket = await insertInvoice({
      dueAt: daysAgo(15),
      balanceDue: "200.00",
    });
    const outOfBucket = await insertInvoice({
      dueAt: daysAgo(45),
      balanceDue: "200.00",
    });

    const res = await request(appMod.default)
      .get("/api/invoices")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .query({ overdueBucket: "0_30" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const ids: string[] = res.body.data.map((r: any) => r.id);
    expect(ids).toContain(inBucket);
    expect(ids).not.toContain(outOfBucket);
  });

  it("31_60 bucket returns only invoices whose dueAt is 31–60 days overdue", async () => {
    const inBucket = await insertInvoice({
      dueAt: daysAgo(45),
      balanceDue: "200.00",
    });
    const outOfBucket = await insertInvoice({
      dueAt: daysAgo(10),
      balanceDue: "200.00",
    });

    const res = await request(appMod.default)
      .get("/api/invoices")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .query({ overdueBucket: "31_60" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const ids: string[] = res.body.data.map((r: any) => r.id);
    expect(ids).toContain(inBucket);
    expect(ids).not.toContain(outOfBucket);
  });

  it("61_90 bucket returns only invoices whose dueAt is 61–90 days overdue", async () => {
    const inBucket = await insertInvoice({
      dueAt: daysAgo(75),
      balanceDue: "200.00",
    });
    const outOfBucket = await insertInvoice({
      dueAt: daysAgo(45),
      balanceDue: "200.00",
    });

    const res = await request(appMod.default)
      .get("/api/invoices")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .query({ overdueBucket: "61_90" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const ids: string[] = res.body.data.map((r: any) => r.id);
    expect(ids).toContain(inBucket);
    expect(ids).not.toContain(outOfBucket);
  });

  it("90_plus bucket returns only invoices whose dueAt is more than 90 days overdue", async () => {
    const inBucket = await insertInvoice({
      dueAt: daysAgo(120),
      balanceDue: "200.00",
    });
    const outOfBucket = await insertInvoice({
      dueAt: daysAgo(60),
      balanceDue: "200.00",
    });

    const res = await request(appMod.default)
      .get("/api/invoices")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .query({ overdueBucket: "90_plus" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const ids: string[] = res.body.data.map((r: any) => r.id);
    expect(ids).toContain(inBucket);
    expect(ids).not.toContain(outOfBucket);
  });

  it("overdue buckets exclude frozen invoices regardless of dueAt", async () => {
    const frozen = await insertInvoice({
      dueAt: daysAgo(15),
      balanceDue: "200.00",
      frozen: true,
    });

    const res = await request(appMod.default)
      .get("/api/invoices")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .query({ overdueBucket: "0_30" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const ids: string[] = res.body.data.map((r: any) => r.id);
    expect(ids).not.toContain(frozen);
  });
});
