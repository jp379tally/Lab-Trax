/**
 * Integration tests: frozen invoices must not appear in overdue bucket results
 * or in the practice-summary open balance.
 *
 * Skipped when DATABASE_URL is not configured. All inserted rows are removed
 * in afterAll so the suite is safe to run against a shared dev DB.
 *
 * Coverage:
 *  - GET /api/invoices?overdueBucket=0_30: frozen invoice is absent even when
 *    its balanceDue > 0 and dueAt is overdue.
 *  - GET /api/invoices/practice-summary: frozen invoice is excluded from
 *    openCount, openBalance, and aging buckets.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";
import request from "supertest";
import * as path from "node:path";
import * as os from "node:os";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(
    os.tmpdir(),
    "labtrax-test-media-frozen-invoice-reports",
  ),
  extractMediaFileName: () => null,
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("Frozen invoice exclusion from overdue/balance-due reports (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let auth: typeof import("../lib/auth.js");

  const labOrgId = rid("lab");
  const providerOrgId = rid("prov");
  const adminUserId = rid("uadmin");

  let adminToken: string;

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

  async function insertInvoice(opts: {
    invoiceNumber: string;
    status?: string;
    frozen?: boolean;
    balanceDue?: string;
    total?: string;
    dueAt?: Date;
  }) {
    const { db, invoices } = dbMod as any;
    const id = rid("inv");
    await db.insert(invoices).values({
      id,
      invoiceNumber: opts.invoiceNumber,
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      status: opts.status ?? "open",
      frozen: opts.frozen ?? false,
      balanceDue: opts.balanceDue ?? "100.00",
      total: opts.total ?? "100.00",
      dueAt: opts.dueAt ?? new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
      createdByUserId: adminUserId,
    });
    return id;
  }

  let frozenInvoiceId: string;
  let openInvoiceId: string;

  beforeAll(async () => {
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    auth = await import("../lib/auth.js");

    const { db, organizations, users, organizationMemberships } =
      dbMod as any;

    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: "Test Lab (Frozen)" },
      {
        id: providerOrgId,
        type: "provider",
        name: "Test Practice (Frozen)",
        parentLabOrganizationId: labOrgId,
      },
    ]);

    await db.insert(users).values({
      id: adminUserId,
      username: rid("uadm"),
      password: "x",
      role: "admin",
    });

    await db.insert(organizationMemberships).values({
      id: rid("m"),
      labId: labOrgId,
      userId: adminUserId,
      role: "admin",
      status: "active",
    });

    adminToken = await makeSession(adminUserId);

    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);

    frozenInvoiceId = await insertInvoice({
      invoiceNumber: "INV-FROZEN-001",
      status: "open",
      frozen: true,
      balanceDue: "250.00",
      total: "250.00",
      dueAt: tenDaysAgo,
    });

    openInvoiceId = await insertInvoice({
      invoiceNumber: "INV-OPEN-001",
      status: "open",
      frozen: false,
      balanceDue: "150.00",
      total: "150.00",
      dueAt: tenDaysAgo,
    });
  });

  // Refresh session token before every test so a concurrent user_sessions
  // wipe does not invalidate the shared token mid-suite.
  beforeEach(async () => {
    adminToken = await makeSession(adminUserId);
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const {
      db,
      organizations,
      users,
      invoices,
      organizationMemberships,
      userSessions,
    } = dbMod as any;

    await db
      .delete(invoices)
      .where(eq(invoices.labOrganizationId, labOrgId));
    await db
      .delete(organizationMemberships)
      .where(eq(organizationMemberships.labId, labOrgId));
    await db
      .delete(userSessions)
      .where(eq(userSessions.userId, adminUserId));
    await db
      .delete(users)
      .where(eq(users.id, adminUserId));
    await db
      .delete(organizations)
      .where(
        inArray(organizations.id, [labOrgId, providerOrgId]),
      );
  });

  it("overdue bucket: open invoice appears, frozen invoice does not", async () => {
    const res = await request(appMod.default)
      .get("/api/invoices")
      .query({
        labOrganizationId: labOrgId,
        overdueBucket: "0_30",
      })
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    const list: any[] = res.body.data ?? res.body;
    const ids = list.map((r: any) => r.id);
    expect(ids).toContain(openInvoiceId);
    expect(ids).not.toContain(frozenInvoiceId);
  });

  it("practice-summary: frozen invoice excluded from openCount and openBalance", async () => {
    const res = await request(appMod.default)
      .get("/api/invoices/practice-summary")
      .query({
        providerOrganizationId: providerOrgId,
        labOrganizationId: labOrgId,
      })
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    const body = (res.body.data ?? res.body) as any;

    expect(Number(body.totals.openCount)).toBe(1);
    expect(Number(body.totals.openBalance)).toBeCloseTo(150, 0);

    const aging = body.aging ?? {};
    const agingTotal =
      Number(aging.current ?? 0) +
      Number(aging.days_1_30 ?? 0) +
      Number(aging.days_31_60 ?? 0) +
      Number(aging.days_61_90 ?? 0) +
      Number(aging.days_90_plus ?? 0);
    expect(agingTotal).toBeCloseTo(150, 0);
  });
});
