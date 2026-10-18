import { createHash, randomBytes } from "node:crypto";
import type { Express } from "express";
import { eq, inArray } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/statements.js")>();
  return { ...actual, startStatementScheduler: vi.fn() };
});
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
}));

const SHOULD_RUN = !!process.env.DATABASE_URL;
const maybe = SHOULD_RUN ? describe : describe.skip;
const rid = (prefix: string) => `${prefix}_${randomBytes(8).toString("hex")}`;

maybe("statement account-summary pagination (db integration)", () => {
  type DbModule = typeof import("@workspace/db");
  let dbMod: DbModule;
  let app: Express;
  let token = "";

  const labId = rid("summary_page_lab");
  const userId = rid("summary_page_user");
  const membershipId = rid("summary_page_member");
  const sessionId = rid("summary_page_session");
  const practiceIds = Array.from({ length: 12 }, () => rid("summary_page_practice"));
  const invoiceIds = Array.from({ length: 13 }, () => rid("summary_page_invoice"));
  const statementIds = Array.from({ length: 12 }, () => rid("summary_page_statement"));

  beforeAll(async () => {
    process.env.JWT_SECRET ||= "statement-summary-pagination-test-secret";
    dbMod = await import("@workspace/db");
    app = (await import("../app.js")).default;
    const {
      db,
      invoices,
      organizationMemberships,
      organizations,
      practiceStatements,
      userSessions,
      users,
    } = dbMod as any;

    await db.insert(users).values({ id: userId, username: userId, password: "x" });
    await db.insert(organizations).values([
      { id: labId, type: "lab", name: "Summary Pagination Lab" },
      ...practiceIds.map((id, index) => ({
        id,
        type: "provider",
        name: `Practice ${String(index + 1).padStart(2, "0")}`,
        parentLabOrganizationId: labId,
      })),
    ]);
    await db.insert(organizationMemberships).values({
      id: membershipId,
      labId,
      userId,
      role: "admin",
      status: "active",
    });
    await db.insert(invoices).values([
      ...practiceIds.map((practiceId, index) => ({
        id: invoiceIds[index],
        invoiceNumber: `SUMMARY-${index + 1}-${invoiceIds[index]}`,
        labOrganizationId: labId,
        providerOrganizationId: practiceId,
        status: index === 0 ? "paid" : "open",
        total: String(100 + index),
        balanceDue: index === 0 ? "0" : String(100 + index),
        createdByUserId: userId,
      })),
      {
        id: invoiceIds[12],
        invoiceNumber: `SUMMARY-PAID-${invoiceIds[12]}`,
        labOrganizationId: labId,
        providerOrganizationId: practiceIds[11],
        status: "paid",
        total: "50",
        balanceDue: "0",
        createdByUserId: userId,
      },
    ]);
    await db.insert(practiceStatements).values(
      practiceIds.map((practiceId, index) => ({
        id: statementIds[index],
        labOrganizationId: labId,
        providerOrganizationId: practiceId,
        periodStart: new Date("2020-01-01T00:00:00.000Z"),
        periodEnd: new Date("2020-01-31T23:59:59.999Z"),
        invoiceCount: index >= 2 ? 1 : 0,
        totalBilled: index >= 2 ? String(100 + index) : "0",
        totalPaid: "0",
        balanceDue: index >= 2 ? String(100 + index) : "0",
        invoiceIdsJson: index >= 2 ? [invoiceIds[index]] : [],
        invoiceAmountsJson:
          index >= 2 ? { [invoiceIds[index]]: String(100 + index) } : {},
        invoiceDetailsJson: {},
        createdByUserId: userId,
        createdAt: new Date(`2025-${String(index + 1).padStart(2, "0")}-01T00:00:00.000Z`),
      })),
    );

    const auth = await import("../lib/auth.js");
    token = auth.signAccessToken(userId, sessionId);
    await db.insert(userSessions).values({
      id: sessionId,
      userId,
      tokenHash: createHash("sha256").update(token).digest("hex"),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
  });

  afterAll(async () => {
    if (!SHOULD_RUN || !dbMod) return;
    const {
      db,
      invoices,
      organizationMemberships,
      organizations,
      practiceStatements,
      userSessions,
      users,
    } = dbMod as any;
    await db.delete(practiceStatements).where(inArray(practiceStatements.id, statementIds));
    await db.delete(invoices).where(inArray(invoices.id, invoiceIds));
    await db.delete(userSessions).where(eq(userSessions.id, sessionId));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.id, membershipId));
    await db.delete(organizations).where(inArray(organizations.id, practiceIds));
    await db.delete(organizations).where(eq(organizations.id, labId));
    await db.delete(users).where(eq(users.id, userId));
  });

  const get = (query: Record<string, string | number>) =>
    request(app)
      .get(`/api/lab-orgs/${labId}/statements/account-summaries`)
      .query(query)
      .set("Authorization", `Bearer ${token}`);

  it("pages newest-first while keeping row and full-set aggregates correct", async () => {
    const first = await get({ limit: 10, offset: 0 });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.data).toMatchObject({
      total: 12,
      limit: 10,
      offset: 0,
      hasMore: true,
      totals: { billed: 1316, paid: 150, open: 1166, overdue: 1065 },
    });
    expect(first.body.data.rows).toHaveLength(10);
    expect(first.body.data.rows[0]).toMatchObject({
      practiceId: practiceIds[11],
      invoiceCount: 2,
      totalBilled: 161,
      totalPaid: 50,
      hasLegacyStatements: true,
    });
    expect(first.body.data.rows[0].unpaidStatements[0].detailProvenance).toBe("live");

    const second = await get({ limit: 10, offset: 10 });
    expect(second.status).toBe(200);
    expect(second.body.data.rows.map((row: { practiceId: string }) => row.practiceId))
      .toEqual(expect.arrayContaining([practiceIds[1], practiceIds[0]]));
    expect(second.body.data.hasMore).toBe(false);
  });

  it("applies search and aging filters before totals and paging", async () => {
    const searched = await get({ limit: 10, search: "practice 02" });
    expect(searched.status).toBe(200);
    expect(searched.body.data.total).toBe(1);
    expect(searched.body.data.rows[0].practiceId).toBe(practiceIds[1]);
    expect(searched.body.data.totals).toEqual({
      billed: 101,
      paid: 0,
      open: 101,
      overdue: 0,
    });

    const open = await get({ limit: 10, aging: "open" });
    expect(open.body.data.total).toBe(11);
    const overdue = await get({ limit: 10, aging: "overdue" });
    expect(overdue.body.data.total).toBe(10);
    expect(overdue.body.data.totals.overdue).toBe(1065);
  });

  it("applies sort and sortDir to the complete filtered set", async () => {
    const ascending = await get({
      limit: 10,
      sort: "practiceName",
      sortDir: "asc",
    });
    expect(ascending.status).toBe(200);
    expect(ascending.body.data.rows[0].practiceId).toBe(practiceIds[0]);

    const descending = await get({
      limit: 10,
      sort: "totalOpenBalance",
      sortDir: "desc",
    });
    expect(descending.status).toBe(200);
    expect(descending.body.data.rows[0].practiceId).toBe(practiceIds[11]);
  });
});