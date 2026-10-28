import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { inArray } from "drizzle-orm";
import request from "supertest";

vi.mock("../lib/backup.js", () => ({ restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({ startDailyOrphanedMediaCleanup: vi.fn() }));

const maybe = process.env["DATABASE_URL"] ? describe : describe.skip;
const rid = (prefix: string) => `${prefix}_${randomBytes(6).toString("hex")}`;

maybe("GET /api/invoices paginated list", () => {
  let dbMod: typeof import("@workspace/db");
  let app: import("express").Express;
  let token = "";
  const labId = rid("lab");
  const practiceId = rid("practice");
  const userId = rid("user");
  const invoiceIds: string[] = [];

  beforeAll(async () => {
    process.env["JWT_SECRET"] ??= "invoice-pagination-test-secret";
    dbMod = await import("@workspace/db");
    app = (await import("../app.js")).default;
    await (await import("./index.js")).labtraxRoutesReady;
    const auth = await import("../lib/auth.js");
    const { db, users, organizations, organizationMemberships, userSessions, invoices } = dbMod;
    await db.insert(users).values({ id: userId, username: rid("billing"), password: "x" });
    await db.insert(organizations).values([
      { id: labId, type: "lab", name: "Pagination Lab" },
      { id: practiceId, type: "provider", name: "Alpha Practice", parentLabOrganizationId: labId },
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

    const yesterday = new Date(Date.now() - 86_400_000);
    for (let index = 0; index < 12; index++) {
      const id = rid("invoice");
      invoiceIds.push(id);
      await db.insert(invoices).values({
        id,
        invoiceNumber: `BATCH-${String(index).padStart(2, "0")}`,
        labOrganizationId: labId,
        providerOrganizationId: practiceId,
        status: "open",
        total: "100.00",
        balanceDue: "100.00",
        dueAt: yesterday,
        issuedAt: new Date(Date.UTC(2025, 0, index + 1)),
        createdAt: new Date(Date.UTC(2025, 0, index + 1)),
        createdByUserId: userId,
        frozen: index === 0,
        displayMetadataJson: {
          patientName: index === 1 ? "Unique Patient" : `Patient ${index}`,
          billTo: "Dr Batch",
        },
      });
    }
    const paidId = rid("invoice");
    invoiceIds.push(paidId);
    await db.insert(invoices).values({
      id: paidId,
      invoiceNumber: "BATCH-PAID",
      labOrganizationId: labId,
      providerOrganizationId: practiceId,
      status: "paid",
      total: "50.00",
      balanceDue: "0.00",
      dueAt: yesterday,
      issuedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      createdByUserId: userId,
      displayMetadataJson: { patientName: "Paid Patient", billTo: "Dr Batch" },
    });
  }, 60_000);

  afterAll(async () => {
    if (!process.env["DATABASE_URL"]) return;
    const { db, invoices, userSessions, organizationMemberships, organizations, users } = dbMod;
    await db.delete(invoices).where(inArray(invoices.id, invoiceIds));
    await db.delete(userSessions).where(inArray(userSessions.userId, [userId]));
    await db.delete(organizationMemberships).where(inArray(organizationMemberships.userId, [userId]));
    await db.delete(organizations).where(inArray(organizations.id, [practiceId, labId]));
    await db.delete(users).where(inArray(users.id, [userId]));
  });

  const get = (query: Record<string, string | number>) =>
    request(app).get("/api/invoices").set("Authorization", `Bearer ${token}`).query(query);

  it("slices newest-first and reports full filtered summary", async () => {
    const response = await get({ search: "batch", limit: 10, offset: 0 });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const page = response.body.data;
    expect(page.rows).toHaveLength(10);
    expect(page.total).toBe(13);
    expect(page.hasMore).toBe(true);
    expect(page.rows[0].invoiceNumber).toBe("BATCH-PAID");
    expect(page.summary).toEqual({
      openBalance: 1100,
      openCount: 11,
      overdueBalance: 1100,
      overdueCount: 11,
      sumTotal: 1250,
      sumBalance: 1200,
      paidThisMonth: 50,
      paidCount: 1,
      totalInvoices: 13,
      statusCounts: { all: 13, open: 12, overdue: 12, paid: 1, draft: 0, void: 0 },
    });

    const second = await get({ search: "batch", limit: 10, offset: 10 });
    expect(second.body.data.rows).toHaveLength(3);
  });

  it("keeps tab counts independent of status, applies non-status filters, and preserves all-time scope", async () => {
    const paid = await get({ statuses: "paid", limit: 1 });
    expect(paid.body.data.total).toBe(1);
    expect(paid.body.data.summary.statusCounts).toEqual({
      all: 13, open: 12, overdue: 12, paid: 1, draft: 0, void: 0,
    });
    const searched = await get({ statuses: "paid", search: "unique patient", limit: 1 });
    expect(searched.body.data.total).toBe(0);
    expect(searched.body.data.summary.statusCounts).toEqual({
      all: 1, open: 1, overdue: 1, paid: 0, draft: 0, void: 0,
    });
    expect(searched.body.data.summary.totalInvoices).toBe(13);
    const foreign = await get({ labOrganizationId: rid("foreign"), limit: 1 });
    expect(foreign.body.data.total).toBe(0);
    expect(foreign.body.data.summary.totalInvoices).toBe(0);
    expect(foreign.body.data.summary.statusCounts.all).toBe(0);
  });

  it("keeps both unfrozen draft types unchanged through selected and lab-wide bulk writes", async () => {
    const { db, organizations, organizationMemberships, invoices, invoiceLineItems } = dbMod;
    const draftLabId = rid("lab");
    const draftPracticeId = rid("practice");
    const membershipId = rid("membership");
    const ids = [rid("invoice"), rid("invoice")];
    invoiceIds.push(...ids);
    await db.insert(organizations).values([
      { id: draftLabId, type: "lab", name: "Isolated Draft Lab" },
      { id: draftPracticeId, type: "provider", name: "Draft Practice", parentLabOrganizationId: draftLabId },
    ]);
    await db.insert(organizationMemberships).values({
      id: membershipId, labId: draftLabId, userId, role: "admin", status: "active",
    });
    await db.insert(invoices).values(ids.map((id, index) => ({
      id, invoiceNumber: `PROTECTED-DRAFT-${index}`, labOrganizationId: draftLabId,
      providerOrganizationId: draftPracticeId, status: index ? "recovery_draft" : "draft",
      frozen: false, subtotal: "10.00", total: "10.00", balanceDue: "10.00", createdByUserId: userId,
    })));
    await db.insert(invoiceLineItems).values(ids.map((invoiceId) => ({
      id: rid("line"), invoiceId, description: "Original draft charge", quantity: 1, unitPrice: "10.00", lineTotal: "10.00",
    })));
    const post = (path: string, body: Record<string, unknown>) =>
      request(app).post(`/api/invoices/${path}`).set("Authorization", `Bearer ${token}`).send(body);
    try {
      const changed = await post("bulk-status", { invoiceIds: ids, status: "paid" });
      expect(changed.status, JSON.stringify(changed.body)).toBe(200);
      expect(changed.body.data.updatedCount).toBe(0);
      expect(changed.body.data.skippedDraftCount).toBe(2);
      for (const id of ids) {
        const edited = await request(app).patch(`/api/invoices/${id}`)
          .set("Authorization", `Bearer ${token}`).send({ status: "open", items: [] });
        expect(edited.status, JSON.stringify(edited.body)).toBe(409);
      }
      for (const body of [{ invoiceIds: ids }, { all: true, labOrganizationId: draftLabId }]) {
        const reset = await post("bulk-reset", body);
        expect(reset.status, JSON.stringify(reset.body)).toBe(200);
        expect(reset.body.data.resetCount).toBe(0);
        expect(reset.body.data.skippedDraftCount).toBe(2);
      }
      const preserved = await db.select().from(invoices).where(inArray(invoices.id, ids));
      expect(preserved.map((row) => row.status).sort()).toEqual(["draft", "recovery_draft"]);
      expect(preserved.every((row) => Number(row.total) === 10 && Number(row.balanceDue) === 10)).toBe(true);
      expect(await db.select().from(invoiceLineItems).where(inArray(invoiceLineItems.invoiceId, ids))).toHaveLength(2);
    } finally {
      await db.delete(invoices).where(inArray(invoices.id, ids));
      await db.delete(organizationMemberships).where(inArray(organizationMemberships.id, [membershipId]));
      await db.delete(organizations).where(inArray(organizations.id, [draftPracticeId, draftLabId]));
    }
  });

  it("reads draft tab filtering without adding a status mutation path", async () => {
    const { db, invoices } = dbMod;
    const id = rid("invoice");
    const heldId = rid("invoice");
    invoiceIds.push(id, heldId);
    await db.insert(invoices).values({
      id, invoiceNumber: "TAB-DRAFT", labOrganizationId: labId,
      providerOrganizationId: practiceId, status: "draft", total: "10.00",
      balanceDue: "10.00", createdByUserId: userId,
    });
    await db.insert(invoices).values({
      id: heldId, invoiceNumber: "TAB-HELD", labOrganizationId: labId,
      providerOrganizationId: practiceId, status: "recovery_draft", frozen: true,
      total: "20.00", balanceDue: "20.00", createdByUserId: userId,
    });
    try {
      const response = await get({ statuses: "draft", search: "TAB-", limit: 25 });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(new Set(response.body.data.rows.map((r: { id: string }) => r.id))).toEqual(new Set([id, heldId]));
      expect(response.body.data.summary.statusCounts).toEqual({
        all: 2, open: 0, overdue: 0, paid: 0, draft: 2, void: 0,
      });
    } finally {
      await db.delete(invoices).where(inArray(invoices.id, [id, heldId]));
    }
  });

  it("applies search, issued range, status union, outstanding view, and sorting", async () => {
    const searched = await get({ search: "unique patient", limit: 10 });
    expect(searched.body.data.total).toBe(1);

    const issued = await get({
      issuedFrom: "2025-01-02T00:00:00.000Z",
      issuedTo: "2025-01-03T00:00:00.000Z",
      limit: 10,
    });
    expect(issued.body.data.rows.map((row: { invoiceNumber: string }) => row.invoiceNumber))
      .toEqual(["BATCH-01"]);

    const statuses = await get({ statuses: "paid,zero_balance", limit: 10 });
    expect(statuses.body.data.total).toBe(1);
    expect(statuses.body.data.rows[0].invoiceNumber).toBe("BATCH-PAID");

    const outstanding = await get({ view: "outstanding", limit: 10 });
    expect(outstanding.body.data.total).toBe(12);

    const sorted = await get({ search: "batch", sort: "issued", sortDir: "asc", limit: 10 });
    expect(sorted.body.data.rows[0].invoiceNumber).toBe("BATCH-00");

    const currentSorted = await get({
      search: "batch",
      sortBy: "issued",
      sortDirection: "asc",
      limit: 10,
    });
    expect(currentSorted.status, JSON.stringify(currentSorted.body)).toBe(200);
    expect(currentSorted.body.data.rows[0].invoiceNumber).toBe("BATCH-00");
  });

  it("filters and pages Customer Center invoices by entered date without changing issue-date filters", async () => {
    const { db, invoices } = dbMod;
    const enteredOct19IssuedOct18 = rid("invoice");
    const enteredOct19IssuedOct20 = rid("invoice");
    const enteredOct19WithoutIssueDate = rid("invoice");
    const enteredOct18IssuedOct19 = rid("invoice");
    const fixtures = [
      {
        id: enteredOct19IssuedOct18,
        number: "CC-ENTERED-19-ISSUED-18",
        createdAt: "2026-10-19T09:00:00.000Z",
        issuedAt: "2026-10-18T12:00:00.000Z",
      },
      {
        id: enteredOct19IssuedOct20,
        number: "CC-ENTERED-19-ISSUED-20",
        createdAt: "2026-10-19T15:00:00.000Z",
        issuedAt: "2026-10-20T12:00:00.000Z",
      },
      {
        id: enteredOct19WithoutIssueDate,
        number: "CC-ENTERED-19-NO-ISSUE",
        createdAt: "2026-10-19T20:00:00.000Z",
        issuedAt: null,
      },
      {
        id: enteredOct18IssuedOct19,
        number: "CC-ENTERED-18-ISSUED-19",
        createdAt: "2026-10-18T23:59:00.000Z",
        issuedAt: "2026-10-19T12:00:00.000Z",
      },
    ];
    invoiceIds.push(...fixtures.map((fixture) => fixture.id));
    await db.insert(invoices).values(fixtures.map((fixture) => ({
      id: fixture.id,
      invoiceNumber: fixture.number,
      labOrganizationId: labId,
      providerOrganizationId: practiceId,
      status: "void",
      total: "10.00",
      balanceDue: "0.00",
      createdAt: new Date(fixture.createdAt),
      issuedAt: fixture.issuedAt ? new Date(fixture.issuedAt) : null,
      createdByUserId: userId,
    })));

    const enteredDateQuery = {
      customerCenter: "true",
      practiceId,
      search: "CC-",
      dateFrom: "2026-10-19T00:00:00.000Z",
      dateTo: "2026-10-19T23:59:59.999Z",
      limit: 1,
    };
    const firstPage = await get({ ...enteredDateQuery, offset: 0 });
    expect(firstPage.status, JSON.stringify(firstPage.body)).toBe(200);
    expect(firstPage.body.data.total).toBe(3);
    expect(firstPage.body.data.hasMore).toBe(true);
    expect(firstPage.body.data.rows[0].createdAt).toBe("2026-10-19T20:00:00.000Z");

    const secondPage = await get({ ...enteredDateQuery, offset: 1 });
    expect(secondPage.status, JSON.stringify(secondPage.body)).toBe(200);
    expect(secondPage.body.data.total).toBe(3);
    expect(secondPage.body.data.hasMore).toBe(true);
    expect(secondPage.body.data.rows[0].createdAt).toBe("2026-10-19T15:00:00.000Z");
    const thirdPage = await get({ ...enteredDateQuery, offset: 2 });
    expect(thirdPage.body.data.total).toBe(3);
    expect(thirdPage.body.data.hasMore).toBe(false);
    expect(thirdPage.body.data.rows[0].createdAt).toBe("2026-10-19T09:00:00.000Z");

    const unpagedExport = await get({
      customerCenter: "true",
      practiceId,
      search: "CC-",
      dateFrom: enteredDateQuery.dateFrom,
      dateTo: enteredDateQuery.dateTo,
    });
    expect(unpagedExport.status, JSON.stringify(unpagedExport.body)).toBe(200);
    expect(unpagedExport.body.data.map((row: { id: string }) => row.id).sort())
      .toEqual([
        enteredOct19IssuedOct18,
        enteredOct19IssuedOct20,
        enteredOct19WithoutIssueDate,
      ].sort());

    const ordinaryIssueDateQuery = await get({
      practiceId,
      dateFrom: "2026-10-18T00:00:00.000Z",
      dateTo: "2026-10-18T23:59:59.999Z",
      limit: 10,
    });
    expect(ordinaryIssueDateQuery.status, JSON.stringify(ordinaryIssueDateQuery.body)).toBe(200);
    expect(ordinaryIssueDateQuery.body.data.rows.map((row: { id: string }) => row.id))
      .toContain(enteredOct19IssuedOct18);
    expect(ordinaryIssueDateQuery.body.data.rows.map((row: { id: string }) => row.id))
      .not.toContain(enteredOct19IssuedOct20);

    const customerCenterWithoutPractice = await get({ customerCenter: "true" });
    expect(customerCenterWithoutPractice.status).toBe(400);
  });

  it("uses the legacy sort pair when valid legacy and current sort parameters conflict", async () => {
    const response = await get({
      search: "batch",
      sort: "issued",
      sortDir: "asc",
      sortBy: "issued",
      sortDirection: "desc",
      limit: 10,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.rows[0].invoiceNumber).toBe("BATCH-00");
  });

  it("counts and pages the UTC issue day, including noon and created-date fallback", async () => {
    const { db, invoices } = dbMod;
    const fixtures = [
      { number: "DAY-PREV", issuedAt: "2025-12-31T23:59:59.999Z", createdAt: "2026-01-01T12:00:00.000Z" },
      { number: "DAY-MIDNIGHT", issuedAt: "2026-01-01T00:00:00.000Z", createdAt: "2025-12-31T12:00:00.000Z" },
      { number: "DAY-NOON", issuedAt: "2026-01-01T12:00:00.000Z", createdAt: "2025-12-31T12:00:00.000Z" },
      { number: "DAY-FALLBACK", issuedAt: null, createdAt: "2026-01-01T23:59:59.999Z" },
      { number: "DAY-NEXT", issuedAt: "2026-01-02T00:00:00.000Z", createdAt: "2026-01-01T12:00:00.000Z" },
    ];
    for (const fixture of fixtures) {
      const id = rid("invoice");
      invoiceIds.push(id);
      await db.insert(invoices).values({
        id, invoiceNumber: fixture.number, labOrganizationId: labId,
        providerOrganizationId: practiceId, status: "void", total: "10.00",
        balanceDue: "0.00", issuedAt: fixture.issuedAt ? new Date(fixture.issuedAt) : null,
        createdAt: new Date(fixture.createdAt), createdByUserId: userId,
      });
    }
    const query = {
      search: "DAY-", issuedFrom: "2026-01-01T00:00:00.000Z",
      issuedTo: "2026-01-02T00:00:00.000Z", sortBy: "issued", limit: 2,
    };
    const first = await get({ ...query, offset: 0 });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.data.total).toBe(3);
    expect(first.body.data.hasMore).toBe(true);
    const second = await get({ ...query, offset: 2 });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.data.total).toBe(3);
    expect(second.body.data.hasMore).toBe(false);
    expect([...first.body.data.rows, ...second.body.data.rows]
      .map((row: { invoiceNumber: string }) => row.invoiceNumber).sort())
      .toEqual(["DAY-FALLBACK", "DAY-MIDNIGHT", "DAY-NOON"]);
  });
});