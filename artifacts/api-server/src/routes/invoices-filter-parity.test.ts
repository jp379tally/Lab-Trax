import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { inArray } from "drizzle-orm";
import request from "supertest";
import {
  INVOICE_FILTER_PARITY_CASES,
  INVOICE_FILTER_PARITY_ROWS,
} from "@workspace/api-client-react/invoice-filter-test-fixtures";
import { dateRangeForFilter } from "@workspace/api-client-react";

vi.mock("../lib/backup.js", () => ({ restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({ startDailyOrphanedMediaCleanup: vi.fn() }));

const maybe = process.env["DATABASE_URL"] ? describe : describe.skip;
const rid = (prefix: string) => `${prefix}_${randomBytes(6).toString("hex")}`;

maybe("GET /api/invoices shared filter parity", () => {
  let dbMod: typeof import("@workspace/db");
  let app: import("express").Express;
  const labId = rid("lab");
  const userId = rid("user");
  const practiceIds = { p1: rid("practice"), p2: rid("practice") };
  const invoiceIds: string[] = [];
  let token = "";

  const getInvoices = (query: Record<string, string | number>) =>
    request(app)
      .get("/api/invoices")
      .set("Authorization", `Bearer ${token}`)
      .query(query);

  const canonicalIds = (response: { body: any }) => {
    const data = response.body.data;
    const rows = Array.isArray(data) ? data : data.rows;
    return rows
      .map((row: { invoiceNumber: string }) => row.invoiceNumber.toLowerCase())
      .filter((id: string) => INVOICE_FILTER_PARITY_ROWS.some((fixture) => fixture.id === id));
  };

  const expectPaginationParity = async (
    query: Record<string, string | number>,
    expectedIds: string[],
  ) => {
    const unpaged = await getInvoices(query);
    expect(unpaged.status, JSON.stringify(unpaged.body)).toBe(200);
    const expected = [...expectedIds].sort();
    expect(canonicalIds(unpaged).sort()).toEqual(expected);

    for (const mode of ["offset", "cursor"] as const) {
      const accumulated: string[] = [];
      let cursor: string | null = null;
      for (let batch = 0; batch < INVOICE_FILTER_PARITY_ROWS.length; batch += 1) {
        const pagedQuery: Record<string, string | number> = { ...query, limit: 2 };
        if (mode === "cursor") {
          if (cursor) pagedQuery.cursor = cursor;
        } else {
          pagedQuery.offset = batch * 2;
        }
        const response = await getInvoices(pagedQuery);
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        const data = response.body.data;
        expect(data.total).toBe(expectedIds.length);
        accumulated.push(...canonicalIds(response));

        if (!data.hasMore) break;
        if (mode === "cursor") {
          expect(data.nextCursor).toEqual(expect.any(String));
          cursor = data.nextCursor;
        }
        if (batch === INVOICE_FILTER_PARITY_ROWS.length - 1) {
          throw new Error(`${mode} invoice paging did not terminate`);
        }
      }
      expect(accumulated.sort()).toEqual(expected);
    }
  };

  beforeAll(async () => {
    process.env["JWT_SECRET"] ??= "invoice-filter-parity-test-secret";
    dbMod = await import("@workspace/db");
    app = (await import("../app.js")).default;
    const auth = await import("../lib/auth.js");
    const { db, users, organizations, organizationMemberships, userSessions, invoices } = dbMod;

    await db.insert(users).values({ id: userId, username: rid("billing"), password: "x" });
    await db.insert(organizations).values([
      { id: labId, type: "lab", name: "Filter Parity Lab" },
      {
        id: practiceIds.p1,
        type: "provider",
        name: "Acme",
        parentLabOrganizationId: labId,
      },
      {
        id: practiceIds.p2,
        type: "provider",
        name: "Zenith",
        parentLabOrganizationId: labId,
      },
    ]);
    await db.insert(organizationMemberships).values({
      id: rid("membership"),
      labId,
      userId,
      role: "admin",
      status: "active",
    });
    const sessionId = rid("session");
    token = auth.signAccessToken(userId, sessionId);
    await db.insert(userSessions).values({
      id: sessionId,
      userId,
      tokenHash: createHash("sha256").update(token).digest("hex"),
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    for (const fixture of INVOICE_FILTER_PARITY_ROWS) {
      const id = rid("invoice");
      invoiceIds.push(id);
      await db.insert(invoices).values({
        id,
        invoiceNumber: fixture.invoiceNumber,
        labOrganizationId: labId,
        providerOrganizationId: fixture.providerOrganizationId
          ? practiceIds[fixture.providerOrganizationId as keyof typeof practiceIds]
          : null,
        status: fixture.status,
        total: String(fixture.total ?? 0),
        balanceDue: String(fixture.balanceDue ?? fixture.total ?? 0),
        dueAt: fixture.dueAt ? new Date(fixture.dueAt) : null,
        issuedAt: fixture.issuedAt ? new Date(fixture.issuedAt) : null,
        createdAt: typeof fixture.createdAt === "string"
          ? new Date(fixture.createdAt)
          : new Date("2026-01-01T00:00:00.000Z"),
        frozen: fixture.frozen ?? false,
        aiGenerated: fixture.aiGenerated === true,
        displayMetadataJson: fixture.displayMetadataJson ?? {},
        createdByUserId: userId,
      });
    }
  }, 60_000);

  afterAll(async () => {
    if (!process.env["DATABASE_URL"]) return;
    const { db, invoices, userSessions, organizationMemberships, organizations, users } = dbMod;
    await db.delete(invoices).where(inArray(invoices.id, invoiceIds));
    await db.delete(userSessions).where(inArray(userSessions.userId, [userId]));
    await db.delete(organizationMemberships).where(inArray(organizationMemberships.userId, [userId]));
    await db.delete(organizations).where(inArray(organizations.id, [practiceIds.p1, practiceIds.p2, labId]));
    await db.delete(users).where(inArray(users.id, [userId]));
  });

  it.each(INVOICE_FILTER_PARITY_CASES)("$name", async ({ options, expectedIds }) => {
    const issuedRange = dateRangeForFilter(
      options.date,
      new Date(2026, 6, 7, 14),
      options.customStart,
      options.customEnd,
    );
    const query: Record<string, string | number> = {
      search: options.search ?? "",
    };
    if (options.view) query.view = options.view;
    if (options.statuses?.length) query.statuses = options.statuses.join(",");
    if (options.status) query.status = options.status;
    if (options.practiceId) {
      query.practiceId = practiceIds[options.practiceId as keyof typeof practiceIds];
    }
    if (options.doctorName) query.doctorName = options.doctorName;
    if (options.aiOnly) query.aiOnly = "true";
    if (issuedRange) {
      query.issuedFrom = issuedRange.start.toISOString();
      query.issuedTo = issuedRange.end.toISOString();
    }
    if (options.overdue) query.overdueBucket = options.overdue;
    if (options.overdueCustomStart) {
      query.dueDateFrom = options.overdueCustomStart.toISOString().slice(0, 10);
    }
    if (options.overdueCustomEnd) {
      query.dueDateTo = options.overdueCustomEnd.toISOString().slice(0, 10);
    }

    await expectPaginationParity(query, expectedIds);
  });

  it.each<{
    name: string;
    query: Record<string, string | number>;
    expectedIds: string[];
  }>([
    {
      name: "issued date range uses inclusive start and exclusive end",
      query: {
        issuedFrom: "2026-07-07T00:00:00.000Z",
        issuedTo: "2026-07-08T00:00:00.000Z",
      },
      expectedIds: ["open-past", "created-fallback"],
    },
    {
      name: "issued date lower bound keeps the created-date fallback",
      query: { issuedFrom: "2026-07-03T00:00:00.000Z" },
      expectedIds: ["open-past", "overdue-status", "void-zero", "created-fallback"],
    },
  ])("$name", async ({ query, expectedIds }) => {
    await expectPaginationParity(query, expectedIds);
  });

  it.each([
    {
      name: "rejects an unsupported legacy status",
      query: { status: "not-a-status" },
      value: "not-a-status",
    },
    {
      name: "rejects an unsupported comma-separated legacy status",
      query: { status: "paid,not-a-status" },
      value: "not-a-status",
    },
    {
      name: "rejects an unsupported comma-separated modern status",
      query: { statuses: "paid,not-a-status" },
      value: "not-a-status",
    },
    {
      name: "rejects an unsupported view",
      query: { view: "archived" },
      value: "archived",
    },
    {
      name: "rejects an unsupported aging bucket",
      query: { overdueBucket: "120_plus" },
      value: "120_plus",
    },
    {
      name: "rejects an unsupported legacy sort field",
      query: { sort: "customer" },
      value: "customer",
    },
    {
      name: "rejects repeated legacy sort values",
      query: { sort: ["issued", "customer"] },
      value: "customer",
    },
    {
      name: "rejects an unsupported legacy sort direction",
      query: { sortDir: "sideways" },
      value: "sideways",
    },
    {
      name: "rejects an unsupported current sort field",
      query: { sortBy: "customer" },
      value: "customer",
    },
    {
      name: "rejects an unsupported current sort direction",
      query: { sortDirection: "sideways" },
      value: "sideways",
    },
    {
      name: "rejects an unsupported legacy sort field even when sortBy is valid",
      query: { sort: "customer", sortBy: "issued" },
      value: "customer",
    },
    {
      name: "rejects an unsupported legacy sort direction even when sortDirection is valid",
      query: { sort: "issued", sortDir: "sideways", sortDirection: "asc" },
      value: "sideways",
    },
    {
      name: "rejects an unsupported current sort field even when legacy sort is valid",
      query: { sort: "issued", sortBy: "customer" },
      value: "customer",
    },
    {
      name: "rejects an unsupported current sort direction even when legacy sortDir is valid",
      query: { sort: "issued", sortDir: "asc", sortDirection: "sideways" },
      value: "sideways",
    },
  ])("$name", async ({ query, value }) => {
    const response = await request(app)
      .get("/api/invoices")
      .set("Authorization", `Bearer ${token}`)
      .query(query);

    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(response.body.message).toContain(value);
  });
});
