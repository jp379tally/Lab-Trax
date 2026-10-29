/**
 * Integration tests for GET /api/invoices/reports/sales (the Reports page's
 * "Total sales" / "Open balance" KPI cards).
 *
 * Background: this endpoint used to filter only on `createdAt` and never
 * excluded deleted, voided, or frozen invoices — so it disagreed with the
 * Invoices page (which excludes all three and filters by
 * `issuedAt ?? createdAt`) and with the sibling /reports/sales-series
 * endpoint (which already used the correct convention). The fix aligns
 * /reports/sales with that same convention:
 *   - soft-deleted invoices are excluded entirely
 *   - voided invoices are excluded entirely
 *   - frozen invoices are excluded from `openBalance` only (they still count
 *     toward `totalSales` — the sale happened even if the case was later
 *     deleted)
 *   - the date range filters on `issuedAt`, falling back to `createdAt`
 *
 * Each test creates its own lab organization so totals are exact and tests
 * never interfere with each other on a shared dev DB. Skipped when
 * DATABASE_URL is not configured.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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

maybe("GET /api/invoices/reports/sales (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let auth: typeof import("../lib/auth.js");

  const adminUserId = rid("uadmin");
  const allLabIds: string[] = [];
  const allInvoiceIds: string[] = [];

  async function makeSession(userId: string): Promise<string> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const token = auth.signAccessToken(userId, sessionId);
    const hash = createHash("sha256").update(token).digest("hex");
    await db
      .insert(userSessions)
      .values({ id: sessionId, userId, tokenHash: hash, expiresAt });
    return token;
  }

  /**
   * Creates a fresh lab + provider org + admin membership + invoices, runs
   * `fn` with the lab id and a caller token scoped to it, then deletes
   * everything it created. Isolating each test in its own lab keeps
   * totalSales/openBalance assertions exact instead of order-dependent.
   */
  async function withLab(
    invoiceSpecs: Array<{
      status?: string;
      frozen?: boolean;
      deletedAt?: Date;
      total?: string;
      subtotal?: string;
      discount?: string;
      tax?: string;
      balanceDue?: string;
      issuedAt?: Date | null;
      createdAt?: Date;
      displayMetadataJson?: Record<string, unknown>;
      practiceName?: string;
      lineItems?: Array<{
        description: string;
        lineTotal: string;
        isDiscount?: boolean;
      }>;
    }>,
    fn: (labOrgId: string, token: string, invoiceIds: string[]) => Promise<void>,
  ): Promise<void> {
    const { db, organizations, organizationMemberships, invoices, invoiceLineItems } =
      dbMod as any;
    const labOrgId = rid("lab");
    const providerOrgId = rid("prov");
    allLabIds.push(labOrgId, providerOrgId);

    const practiceNames = Array.from(
      new Set(invoiceSpecs.map((spec) => spec.practiceName).filter(Boolean)),
    ) as string[];
    const practiceIds = new Map<string, string>();
    const orgRows = [
      { id: labOrgId, type: "lab", name: rid("SalesReportLab") },
      {
        id: providerOrgId,
        type: "provider",
        name: rid("SalesReportPractice"),
        parentLabOrganizationId: labOrgId,
      },
      ...practiceNames.map((name) => {
        const id = rid("prov");
        practiceIds.set(name, id);
        allLabIds.push(id);
        return {
          id,
          type: "provider",
          name,
          parentLabOrganizationId: labOrgId,
        };
      }),
    ];
    await db.insert(organizations).values(orgRows);
    await db.insert(organizationMemberships).values({
      id: rid("m"),
      labId: labOrgId,
      userId: adminUserId,
      role: "admin",
      status: "active",
    });
    const token = await makeSession(adminUserId);

    const invoiceIds: string[] = [];
    for (const spec of invoiceSpecs) {
      const id = rid("inv");
      invoiceIds.push(id);
      allInvoiceIds.push(id);
      await db.insert(invoices).values({
        id,
        invoiceNumber: rid("INV"),
        labOrganizationId: labOrgId,
        providerOrganizationId:
          (spec.practiceName && practiceIds.get(spec.practiceName)) ??
          providerOrgId,
        status: spec.status ?? "open",
        frozen: spec.frozen ?? false,
        subtotal: spec.subtotal ?? "0.00",
        discount: spec.discount ?? "0.00",
        tax: spec.tax ?? "0.00",
        total: spec.total ?? "100.00",
        balanceDue: spec.balanceDue ?? spec.total ?? "100.00",
        createdByUserId: adminUserId,
        ...(spec.deletedAt !== undefined ? { deletedAt: spec.deletedAt } : {}),
        ...(spec.issuedAt !== undefined ? { issuedAt: spec.issuedAt } : {}),
        ...(spec.createdAt !== undefined ? { createdAt: spec.createdAt } : {}),
        ...(spec.displayMetadataJson !== undefined ? { displayMetadataJson: spec.displayMetadataJson } : {}),
      });
      if (spec.lineItems?.length) {
        await db.insert(invoiceLineItems).values(
          spec.lineItems.map((line, sortOrder) => ({
            id: rid("line"),
            invoiceId: id,
            description: line.description,
            quantity: 1,
            unitPrice: line.lineTotal,
            lineTotal: line.lineTotal,
            isDiscount: line.isDiscount ?? true,
            sortOrder,
          })),
        );
      }
    }

    await fn(labOrgId, token, invoiceIds);
  }

  beforeAll(async () => {
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    auth = await import("../lib/auth.js");

    const { db, users } = dbMod as any;
    await db.insert(users).values({
      id: adminUserId,
      username: rid("uadm"),
      password: "x",
      role: "admin",
    });
  }, 180_000);

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const {
      db,
      invoices,
      organizations,
      users,
      organizationMemberships,
      userSessions,
    } = dbMod as any;

    if (allInvoiceIds.length) {
      await db.delete(invoices).where(inArray(invoices.id, allInvoiceIds));
    }
    if (allLabIds.length) {
      await db
        .delete(organizationMemberships)
        .where(inArray(organizationMemberships.labId, allLabIds));
    }
    await db
      .delete(userSessions)
      .where(inArray(userSessions.userId, [adminUserId]));
    if (allLabIds.length) {
      await db.delete(organizations).where(inArray(organizations.id, allLabIds));
    }
    await db.delete(users).where(inArray(users.id, [adminUserId]));
  });

  it("excludes soft-deleted invoices from totalSales and openBalance", async () => {
    await withLab(
      [
        { total: "100.00", balanceDue: "100.00" },
        { total: "500.00", balanceDue: "500.00", deletedAt: new Date() },
      ],
      async (labOrgId, token) => {
        const res = await request(appMod.default)
          .get("/api/invoices/reports/sales")
          .set("Authorization", `Bearer ${token}`)
          .query({ organizationId: labOrgId });

        expect(res.status, JSON.stringify(res.body)).toBe(200);
        const body = (res.body.data ?? res.body) as any;
        expect(Number(body.totalSales)).toBeCloseTo(100, 2);
        expect(Number(body.openBalance)).toBeCloseTo(100, 2);
        expect(Number(body.invoices)).toBe(1);
      },
    );
  });

  it("excludes voided invoices from totalSales and openBalance", async () => {
    await withLab(
      [
        { total: "120.00", balanceDue: "120.00" },
        { status: "void", total: "999.00", balanceDue: "0.00" },
      ],
      async (labOrgId, token) => {
        const res = await request(appMod.default)
          .get("/api/invoices/reports/sales")
          .set("Authorization", `Bearer ${token}`)
          .query({ organizationId: labOrgId });

        expect(res.status, JSON.stringify(res.body)).toBe(200);
        const body = (res.body.data ?? res.body) as any;
        expect(Number(body.totalSales)).toBeCloseTo(120, 2);
        expect(Number(body.openBalance)).toBeCloseTo(120, 2);
        expect(Number(body.invoices)).toBe(1);
      },
    );
  });

  it("excludes frozen invoices from openBalance but still counts them in totalSales", async () => {
    await withLab(
      [
        { total: "300.00", balanceDue: "0.00", frozen: true },
        { total: "80.00", balanceDue: "80.00", frozen: false },
      ],
      async (labOrgId, token) => {
        const res = await request(appMod.default)
          .get("/api/invoices/reports/sales")
          .set("Authorization", `Bearer ${token}`)
          .query({ organizationId: labOrgId });

        expect(res.status, JSON.stringify(res.body)).toBe(200);
        const body = (res.body.data ?? res.body) as any;
        // Frozen invoice's total (300) is still a real historical sale.
        expect(Number(body.totalSales)).toBeCloseTo(380, 2);
        // But its balance must not surface as outstanding money owed.
        expect(Number(body.openBalance)).toBeCloseTo(80, 2);
      },
    );
  });

  it("filters the date range by issuedAt, falling back to createdAt", async () => {
    await withLab(
      [
        {
          total: "50.00",
          balanceDue: "50.00",
          issuedAt: utcMidnight("2024-01-15"),
          createdAt: utcMidnight("2023-06-01"), // would be OUT of range if createdAt were used
        },
        {
          total: "70.00",
          balanceDue: "70.00",
          issuedAt: null,
          createdAt: utcMidnight("2024-01-20"),
        },
        {
          total: "999.00",
          balanceDue: "999.00",
          issuedAt: utcMidnight("2023-11-01"),
          createdAt: utcMidnight("2023-11-01"),
        },
      ],
      async (labOrgId, token) => {
        const res = await request(appMod.default)
          .get("/api/invoices/reports/sales")
          .set("Authorization", `Bearer ${token}`)
          .query({
            organizationId: labOrgId,
            dateFrom: "2024-01-01T00:00:00.000Z",
            dateTo: "2024-01-31T23:59:59.000Z",
          });

        expect(res.status, JSON.stringify(res.body)).toBe(200);
        const body = (res.body.data ?? res.body) as any;
        expect(Number(body.totalSales)).toBeCloseTo(120, 2);
        expect(Number(body.invoices)).toBe(2);
      },
    );
  });

  it("keeps an edited invoice in its original local sales day and uses the saved total everywhere", async () => {
    const issuedAt = new Date("2026-03-10T05:30:00.000Z");
    const createdAt = new Date("2026-10-20T00:03:00.000Z");
    const localDay = {
      dateFrom: "2026-03-10T04:00:00.000Z",
      dateTo: "2026-03-11T03:59:59.999Z",
    };
    await withLab(
      [{
        subtotal: "100.00",
        tax: "10.00",
        discount: "5.00",
        total: "102.00",
        balanceDue: "80.00",
        issuedAt,
        createdAt,
        displayMetadataJson: { credits: 3 },
      }],
      async (labOrgId, token, [invoiceId]) => {
        const headers = { Authorization: `Bearer ${token}` };
        const { db, payments } = dbMod as any;
        const paymentId = rid("sales-edit-payment");
        await db.insert(payments).values({
          id: paymentId,
          invoiceId,
          amount: "22.00",
          paymentMethod: "cash",
          recordedByUserId: adminUserId,
        });

        const patch = async (body: Record<string, unknown>) => {
          const response = await request(appMod.default)
            .patch(`/api/invoices/${invoiceId}`)
            .set(headers)
            .send(body);
          expect(response.status, JSON.stringify(response.body)).toBe(200);
          return response.body.data ?? response.body;
        };
        const getSales = async (from: string, to: string, timeZone = "UTC") => {
          const [sales, invoicesPage, series] = await Promise.all([
            request(appMod.default).get("/api/invoices/reports/sales")
              .set(headers).query({ organizationId: labOrgId, dateFrom: from, dateTo: to }),
            request(appMod.default).get("/api/invoices/reports/sales-invoices")
              .set(headers).query({ organizationId: labOrgId, dateFrom: from, dateTo: to }),
            request(appMod.default).get("/api/invoices/reports/sales-series")
              .set(headers).query({
                organizationId: labOrgId,
                dateFrom: from,
                dateTo: to,
                timeZone,
                groupBy: "day",
              }),
          ]);
          expect(sales.status, JSON.stringify(sales.body)).toBe(200);
          expect(invoicesPage.status, JSON.stringify(invoicesPage.body)).toBe(200);
          expect(series.status, JSON.stringify(series.body)).toBe(200);
          return {
            sales: sales.body.data,
            invoices: invoicesPage.body.data,
            series: series.body.data,
          };
        };

        const before = await getSales(localDay.dateFrom, localDay.dateTo, "America/New_York");
        expect(before.sales).toMatchObject({ invoices: 1, totalSales: "102.00" });
        expect(before.invoices.rows.map((row: any) => row.id)).toEqual([invoiceId]);
        expect(before.series.series).toEqual([
          expect.objectContaining({
            periodStart: "2026-03-10T00:00:00.000Z",
            billedTotal: "102.00",
          }),
        ]);

        const items = [{
          description: "Crown",
          quantity: 1,
          unitPrice: 100,
          subItems: [{ description: "Layered porcelain", quantity: 1, unitPrice: 20 }],
        }];
        await patch({
          items,
          tax: 10,
          discount: 5,
          displayMetadata: { credits: 3 },
        });
        // A second metadata-only save must not duplicate the invoice or reset
        // the total. The payment remains applied to the new gross amount.
        await patch({ notes: "Reviewed without changing the issue date." });

        const detailResponse = await request(appMod.default)
          .get(`/api/invoices/${invoiceId}`)
          .set(headers);
        expect(detailResponse.status, JSON.stringify(detailResponse.body)).toBe(200);
        const detail = detailResponse.body.data ?? detailResponse.body;
        expect(detail.issuedAt).toBe(issuedAt.toISOString());
        expect(detail.status).toBe("open");
        expect(detail.total).toBe("122.00");
        expect(detail.balanceDue).toBe("100.00");
        expect(detail.notes).toBe("Reviewed without changing the issue date.");

        const after = await getSales(localDay.dateFrom, localDay.dateTo, "America/New_York");
        expect(after.sales).toMatchObject({ invoices: 1, totalSales: "122.00", openBalance: "100.00" });
        expect(after.invoices).toMatchObject({ total: 1, billedTotal: "122.00" });
        expect(after.invoices.rows).toEqual([
          expect.objectContaining({ id: invoiceId, total: "122.00" }),
        ]);
        expect(after.series.series).toEqual([
          expect.objectContaining({
            periodStart: "2026-03-10T00:00:00.000Z",
            billedTotal: "122.00",
          }),
        ]);

        const statsResponse = await request(appMod.default)
          .get("/api/stats/summary")
          .set(headers)
          .query({
            organizationId: labOrgId,
            ...localDay,
            timeZone: "America/New_York",
          });
        expect(statsResponse.status, JSON.stringify(statsResponse.body)).toBe(200);
        const stats = statsResponse.body.data ?? statsResponse.body;
        expect(Number(stats.totalRevenue)).toBe(122);
        expect(stats.invoiceCount).toBe(1);

        const movedAt = "2026-03-11T00:00:00.000Z";
        await patch({ issuedAt: movedAt });
        const oldUtcDay = await getSales(
          "2026-03-10T00:00:00.000Z",
          "2026-03-10T23:59:59.999Z",
        );
        const newUtcDay = await getSales(
          "2026-03-11T00:00:00.000Z",
          "2026-03-11T23:59:59.999Z",
        );
        expect(oldUtcDay.sales).toMatchObject({ invoices: 0, totalSales: "0.00" });
        expect(newUtcDay.sales).toMatchObject({ invoices: 1, totalSales: "122.00" });
      },
    );
  });

  it("reports billed totals from persisted invoice totals across date buckets", async () => {
    await withLab(
      [
        {
          subtotal: "100.00",
          discount: "10.00",
          tax: "9.00",
          // The stored total includes a $5 credit: 100 - 10 + 9 - 5.
          total: "94.00",
          issuedAt: utcMidnight("2024-01-01"),
        },
        {
          subtotal: "50.00",
          tax: "5.00",
          total: "55.00",
          issuedAt: utcMidnight("2024-01-08"),
        },
        {
          subtotal: "100.00",
          tax: "10.00",
          total: "110.00",
          issuedAt: utcMidnight("2024-01-15"),
        },
      ],
      async (labOrgId, token) => {
        const headers = { Authorization: `Bearer ${token}` };
        const baseQuery = {
          organizationId: labOrgId,
          dateFrom: "2024-01-01T00:00:00.000Z",
          dateTo: "2024-01-31T23:59:59.000Z",
          timeZone: "UTC",
        };
        const getSeries = async (groupBy: "day" | "week" | "month") => {
          const res = await request(appMod.default)
            .get("/api/invoices/reports/sales-series")
            .set(headers)
            .query({ ...baseQuery, groupBy });
          expect(res.status, JSON.stringify(res.body)).toBe(200);
          return (res.body.data ?? res.body) as any;
        };

        const daily = await getSeries("day");
        expect(daily.series.map((point: any) => point.billedTotal)).toEqual([
          "94.00",
          "55.00",
          "110.00",
        ]);
        expect(daily.series[0]).toMatchObject({
          gross: "100.00",
          discounts: "10.00",
          net: "90.00",
          tax: "9.00",
          billedTotal: "94.00",
          avg: "94.00",
        });
        expect(daily.totals).toMatchObject({
          gross: "250.00",
          discounts: "10.00",
          net: "240.00",
          tax: "24.00",
          billedTotal: "259.00",
          avg: "86.33",
        });

        const weekly = await getSeries("week");
        expect(weekly.series.map((point: any) => point.billedTotal)).toEqual([
          "94.00",
          "55.00",
          "110.00",
        ]);
        const monthly = await getSeries("month");
        expect(monthly.series).toHaveLength(1);
        expect(monthly.series[0]).toMatchObject({
          periodStart: "2024-01-01T00:00:00.000Z",
          billedTotal: "259.00",
        });
        expect(monthly.totals.billedTotal).toBe("259.00");
      },
    );
  });

  it("aggregates header and line discounts by local period, item, and practice", async () => {
    await withLab(
      [
        {
          subtotal: "90.00",
          discount: "5.00",
          total: "85.00",
          practiceName: "North Dental",
          issuedAt: new Date("2024-01-01T04:30:00.000Z"),
          displayMetadataJson: { doctorName: "Dr. North", credits: 75 },
          lineItems: [{ description: "Courtesy", lineTotal: "-10.00" }],
        },
        {
          subtotal: "77.00",
          total: "77.00",
          practiceName: "South Dental",
          issuedAt: null,
          createdAt: new Date("2024-01-01T05:30:00.000Z"),
          lineItems: [
            { description: "Courtesy", lineTotal: "-20.00" },
            { description: "Rush correction", lineTotal: "-3.00" },
          ],
        },
        {
          discount: "999.00",
          status: "void",
          practiceName: "North Dental",
          issuedAt: new Date("2024-01-02T12:00:00.000Z"),
          lineItems: [{ description: "Voided line", lineTotal: "-100.00" }],
        },
        {
          discount: "888.00",
          deletedAt: new Date(),
          practiceName: "South Dental",
          issuedAt: new Date("2024-01-02T12:00:00.000Z"),
          lineItems: [{ description: "Deleted line", lineTotal: "-100.00" }],
        },
        {
          discount: "777.00",
          status: "recovery_draft",
          practiceName: "North Dental",
          issuedAt: new Date("2024-01-02T12:00:00.000Z"),
          lineItems: [{ description: "Held line", lineTotal: "-100.00" }],
        },
        {
          discount: "666.00",
          displayMetadataJson: { recoveryBilling: { state: "held" } },
          practiceName: "South Dental",
          issuedAt: new Date("2024-01-02T12:00:00.000Z"),
          lineItems: [{ description: "Held metadata line", lineTotal: "-100.00" }],
        },
      ],
      async (labOrgId, token) => {
        const headers = { Authorization: `Bearer ${token}` };
        const range = {
          organizationId: labOrgId,
          dateFrom: "2024-01-01T00:00:00.000Z",
          dateTo: "2024-01-03T00:00:00.000Z",
          groupBy: "month",
          timeZone: "America/New_York",
        };
        const discountsResponse = await request(appMod.default)
          .get("/api/invoices/reports/discounts")
          .set(headers)
          .query(range);
        expect(discountsResponse.status, JSON.stringify(discountsResponse.body)).toBe(200);
        const discounts = discountsResponse.body.data;
        expect(discounts.totals).toEqual({ amount: "38.00", count: 2 });
        expect(discounts.series).toEqual([
          {
            periodStart: "2023-12-01T00:00:00.000Z",
            amount: "15.00",
            count: 1,
          },
          {
            periodStart: "2024-01-01T00:00:00.000Z",
            amount: "23.00",
            count: 1,
          },
        ]);
        expect(discounts.items).toEqual([
          { item: "Courtesy", amount: "30.00", count: 2 },
          { item: "Invoice-level discount", amount: "5.00", count: 1 },
          { item: "Rush correction", amount: "3.00", count: 1 },
        ]);
        expect(discounts.practices).toEqual([
          {
            practiceId: expect.any(String),
            practiceName: "South Dental",
            doctorName: null,
            amount: "23.00",
            count: 1,
          },
          {
            practiceId: expect.any(String),
            practiceName: "North Dental",
            doctorName: "Dr. North",
            amount: "15.00",
            count: 1,
          },
        ]);

        const salesResponse = await request(appMod.default)
          .get("/api/invoices/reports/sales-series")
          .set(headers)
          .query(range);
        expect(salesResponse.status, JSON.stringify(salesResponse.body)).toBe(200);
        const sales = salesResponse.body.data;
        expect(sales.totals).toMatchObject({
          gross: "200.00",
          discounts: "38.00",
          net: "162.00",
        });
        expect(
          Number(sales.totals.gross) - Number(sales.totals.discounts),
        ).toBeCloseTo(Number(sales.totals.net), 2);
      },
    );
  });

  it("returns explicit zero totals and empty breakdowns when no discounts match", async () => {
    await withLab([], async (labOrgId, token) => {
      const res = await request(appMod.default)
        .get("/api/invoices/reports/discounts")
        .set("Authorization", `Bearer ${token}`)
        .query({
          organizationId: labOrgId,
          dateFrom: "2025-01-01T00:00:00.000Z",
          dateTo: "2025-01-31T23:59:59.999Z",
          groupBy: "day",
          timeZone: "UTC",
        });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.data).toMatchObject({
        series: [],
        items: [],
        practices: [],
        totals: { amount: "0.00", count: 0 },
      });
    });
  });

  it("pages the exact billed population, including frozen sales, across local-day boundaries", async () => {
    // US Pacific spring DST day is 23 hours; inclusive UTC bounds still describe
    // the selected local calendar date, not the server's UTC date.
    const dateFrom = "2024-03-10T08:00:00.000Z";
    const dateTo = "2024-03-11T06:59:59.999Z";
    await withLab([
      { total: "94.00", subtotal: "100.00", discount: "10.00", tax: "9.00",
        issuedAt: new Date(dateFrom), createdAt: utcMidnight("2023-01-01") },
      { total: "55.00", frozen: true, issuedAt: new Date(dateTo) },
      { total: "20.25", issuedAt: null, createdAt: new Date("2024-03-10T20:00:00Z") },
      { total: "900.00", issuedAt: new Date("2024-03-10T07:59:59.999Z") },
      { total: "901.00", issuedAt: new Date("2024-03-11T07:00:00.000Z") },
      { total: "902.00", status: "void", issuedAt: new Date(dateFrom) },
      { total: "903.00", deletedAt: new Date(), issuedAt: new Date(dateFrom) },
      { total: "904.00", status: "recovery_draft", issuedAt: new Date(dateFrom) },
      { total: "905.00", issuedAt: new Date(dateFrom),
        displayMetadataJson: { recoveryBilling: { state: "held" } } },
    ], async (organizationId, token, ids) => {
      const headers = { Authorization: `Bearer ${token}` };
      const range = { organizationId, dateFrom, dateTo };
      const first = await request(appMod.default).get("/api/invoices/reports/sales-invoices")
        .set(headers).query({ ...range, limit: 2 });
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(first.body.data).toMatchObject({ total: 3, billedTotal: "169.25", offset: 0, hasMore: true });
      expect(first.body.data.rows).toHaveLength(2);
      const second = await request(appMod.default).get("/api/invoices/reports/sales-invoices")
        .set(headers).query({ ...range, limit: 2, offset: 2 });
      expect(second.status).toBe(200);
      expect(second.body.data).toMatchObject({ total: 3, billedTotal: "169.25", offset: 2, hasMore: false });
      const rows = [...first.body.data.rows, ...second.body.data.rows];
      expect(rows.map((row: any) => row.id).sort()).toEqual(ids.slice(0, 3).sort());
      expect(rows.reduce((sum: number, row: any) => sum + Number(row.total), 0)).toBe(169.25);
      expect(rows.every((row: any) => row.invoiceNumber && row.practiceName && row.issuedAt)).toBe(true);
      const sales = await request(appMod.default).get("/api/invoices/reports/sales").set(headers).query(range);
      const series = await request(appMod.default).get("/api/invoices/reports/sales-series")
        .set(headers).query({ ...range, timeZone: "America/Los_Angeles", groupBy: "day" });
      expect(sales.status).toBe(200);
      expect(series.status).toBe(200);
      expect(sales.body.data.totalSales).toBe(first.body.data.billedTotal);
      expect(sales.body.data.invoices).toBe(first.body.data.total);
      expect(series.body.data.totals.billedTotal).toBe(first.body.data.billedTotal);
      expect(series.body.data.totals.count).toBe(first.body.data.total);
    });
  });

  it("retrieves every invoice beyond the default page and returns explicit empty results", async () => {
    await withLab(Array.from({ length: 55 }, () => ({
      total: "1.25", issuedAt: utcMidnight("2024-06-01"),
    })), async (organizationId, token, ids) => {
      const headers = { Authorization: `Bearer ${token}` };
      const range = { organizationId, dateFrom: "2024-06-01T00:00:00Z", dateTo: "2024-06-30T23:59:59.999Z" };
      const first = await request(appMod.default).get("/api/invoices/reports/sales-invoices").set(headers).query(range);
      const second = await request(appMod.default).get("/api/invoices/reports/sales-invoices")
        .set(headers).query({ ...range, offset: 50 });
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(first.body.data.rows).toHaveLength(50);
      expect(first.body.data.hasMore).toBe(true);
      expect(second.body.data.rows).toHaveLength(5);
      expect(second.body.data.hasMore).toBe(false);
      expect(first.body.data.billedTotal).toBe("68.75");
      expect([...first.body.data.rows, ...second.body.data.rows].map((row: any) => row.id).sort()).toEqual([...ids].sort());
      const empty = await request(appMod.default).get("/api/invoices/reports/sales-invoices")
        .set(headers).query({ ...range, dateFrom: "2025-01-01", dateTo: "2025-01-02" });
      expect(empty.status).toBe(200);
      expect(empty.body.data).toEqual({ rows: [], total: 0, billedTotal: "0.00", offset: 0, hasMore: false });
      const foreignLab = await request(appMod.default).get("/api/invoices/reports/sales-invoices")
        .set(headers).query({ ...range, organizationId: rid("foreign") });
      expect(foreignLab.status).toBe(403);
    });
  });

  it("rejects invalid ranges and paging instead of silently omitting invoices", async () => {
    await withLab([], async (organizationId, token) => {
      const headers = { Authorization: `Bearer ${token}` };
      const range = { organizationId, dateFrom: "2024-01-01", dateTo: "2024-01-31" };
      for (const invalid of [
        { dateFrom: "invalid" }, { dateFrom: "2024-02-01" },
        { offset: -1 }, { limit: 0 }, { limit: 101 }, { offset: 1.5 },
      ]) {
        const res = await request(appMod.default).get("/api/invoices/reports/sales-invoices")
          .set(headers).query({ ...range, ...invalid });
        expect(res.status, JSON.stringify(res.body)).toBe(400);
      }
    });
  });

  it("reports the saved parent, rush fee and nested charge; the daily average excludes today's invoice", async () => {
    const from = new Date();
    from.setUTCDate(from.getUTCDate() - 14);
    from.setUTCHours(12, 0, 0, 0);
    const today = new Date();
    today.setUTCHours(12, 0, 0, 0);
    await withLab(
      [
        { total: "5.00", issuedAt: from },
        { total: "5.00", issuedAt: today },
      ],
      async (labOrgId, token, ids) => {
        const headers = { Authorization: `Bearer ${token}` };
        const window = {
          organizationId: labOrgId,
          dateFrom: new Date(from.getTime() - 86_400_000).toISOString(),
          dateTo: new Date(today.getTime() + 36_000_000).toISOString(),
          timeZone: "UTC",
        };
        const summary = async () => {
          const res = await request(appMod.default).get("/api/stats/summary").set(headers).query(window);
          expect(res.status, JSON.stringify(res.body)).toBe(200);
          return res.body.data ?? res.body;
        };
        const first = await summary();
        const items = [
          { description: "Corrected crown", quantity: 1, unitPrice: 10, subItems: [
            { description: "Layered Porcelain", quantity: 1, unitPrice: 37 },
          ] },
          { description: "Rush fee", quantity: 1, unitPrice: 15 },
        ];
        const save = async (id: string) => {
          const res = await request(appMod.default).patch(`/api/invoices/${id}`)
            .set(headers).send({ items });
          expect(res.status, JSON.stringify(res.body)).toBe(200);
          const detail = await request(appMod.default).get(`/api/invoices/${id}`).set(headers);
          expect(detail.status, JSON.stringify(detail.body)).toBe(200);
          const invoice = detail.body.data ?? detail.body;
          expect(Number(invoice.total)).toBe(62);
          expect(invoice.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ description: "Corrected crown", subItems: [
              expect.objectContaining({ description: "Layered Porcelain", unitPrice: "37.00" }),
            ] }),
            expect.objectContaining({ description: "Rush fee", unitPrice: "15.00" }),
          ]));
        };
        await save(ids[0]!);
        const afterPast = await summary();
        expect(Number(afterPast.totalRevenue) - Number(first.totalRevenue)).toBe(57);
        expect(Number(afterPast.averageDailyRevenue)).toBeGreaterThan(Number(first.averageDailyRevenue));
        await save(ids[1]!);
        const afterToday = await summary();
        expect(Number(afterToday.totalRevenue) - Number(afterPast.totalRevenue)).toBe(57);
        expect(afterToday.averageDailyRevenue).toBe(afterPast.averageDailyRevenue);
        const sales = await request(appMod.default).get("/api/invoices/reports/sales")
          .set(headers).query(window);
        expect(sales.status, JSON.stringify(sales.body)).toBe(200);
        expect(Number((sales.body.data ?? sales.body).totalSales)).toBe(124);
      },
    );
  });
});
