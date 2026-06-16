/**
 * Integration tests for Task #1745: Freeze invoice forever when a case is deleted.
 *
 * Verifies:
 *   - Deleting a case sets frozen=true, balanceDue="0.00", caseDeletedNote on
 *     every linked non-deleted invoice.
 *   - The invoice is still readable (not deleted).
 *   - A subsequent POST /invoices/:id/void returns 409.
 *   - A subsequent POST /invoices/:id/write-off returns 409.
 *   - An unlinked invoice in the same lab is NOT frozen.
 *
 * These tests are gated on DATABASE_URL and skip cleanly when it is not set.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";
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

maybe("frozen-invoice (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let auth: typeof import("../lib/auth.js");

  const labOrgId = rid("lab");
  const providerOrgId = rid("prov");
  const adminUserId = rid("uadmin");

  let adminToken: string;
  let caseId: string;
  let invoiceId: string;
  let unlinkedInvoiceId: string;

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

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-frozen-invoice";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    auth = await import("../lib/auth.js");

    const { db, organizations, users, organizationMemberships, cases, invoices } =
      dbMod as any;

    await db.insert(users).values([
      {
        id: adminUserId,
        username: `adm_${adminUserId}`,
        password: "x",
        firstName: "John",
        lastName: "Williams",
        initials: "JW",
        emailVerifiedAt: new Date(),
      },
    ]);

    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: "Test Lab Frozen" },
      { id: providerOrgId, type: "provider", name: "Test Practice Frozen" },
    ]);

    await db.insert(organizationMemberships).values([
      {
        id: rid("m"),
        labId: labOrgId,
        userId: adminUserId,
        role: "admin",
        status: "active",
      },
    ]);

    caseId = rid("case");
    await db.insert(cases).values({
      id: caseId,
      caseNumber: "FRZ-001",
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      doctorName: "Dr. Test",
      patientFirstName: "Pat",
      patientLastName: "Frozen",
      status: "active",
      createdByUserId: adminUserId,
    });

    invoiceId = rid("inv");
    await db.insert(invoices).values({
      id: invoiceId,
      invoiceNumber: "FRZ-INV-001",
      caseId,
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      status: "open",
      subtotal: "100.00",
      tax: "0.00",
      discount: "0.00",
      total: "100.00",
      balanceDue: "100.00",
      createdByUserId: adminUserId,
    });

    unlinkedInvoiceId = rid("inv2");
    await db.insert(invoices).values({
      id: unlinkedInvoiceId,
      invoiceNumber: "FRZ-INV-002",
      caseId: null,
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      status: "open",
      subtotal: "50.00",
      tax: "0.00",
      discount: "0.00",
      total: "50.00",
      balanceDue: "50.00",
      createdByUserId: adminUserId,
    });

    adminToken = await makeSession(adminUserId);
  });

  afterAll(async () => {
    const { db, organizations, users, organizationMemberships, cases, invoices, userSessions } =
      dbMod as any;
    await db.delete(invoices).where(eq(invoices.labOrganizationId, labOrgId));
    await db.delete(cases).where(eq(cases.labOrganizationId, labOrgId));
    await db
      .delete(organizationMemberships)
      .where(eq(organizationMemberships.labId, labOrgId));
    await db
      .delete(organizations)
      .where(eq(organizations.id, labOrgId));
    await db
      .delete(organizations)
      .where(eq(organizations.id, providerOrgId));
    await db.delete(users).where(eq(users.id, adminUserId));
  });

  it("deleting a case freezes its linked invoice", async () => {
    const res = await request(appMod.default)
      .delete(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body.data?.deleted).toBe(true);

    const { db, invoices } = dbMod as any;
    const inv = await db.query.invoices.findFirst({
      where: eq(invoices.id, invoiceId),
    });

    expect(inv).toBeDefined();
    expect(inv.frozen).toBe(true);
    expect(inv.balanceDue).toBe("0.00");
    expect(inv.deletedAt).toBeNull();
    expect(inv.caseDeletedNote).toMatch(/^Case Deleted by /);
    expect(inv.caseDeletedAt).toBeTruthy();
    expect(inv.caseDeletedByUserId).toBe(adminUserId);
  });

  it("frozen invoice note uses actor initials derived from firstName+lastName", async () => {
    const { db, invoices } = dbMod as any;
    const inv = await db.query.invoices.findFirst({
      where: eq(invoices.id, invoiceId),
    });
    expect(inv.caseDeletedNote).toBe("Case Deleted by JW");
  });

  it("unlinked invoice in the same lab is NOT frozen", async () => {
    const { db, invoices } = dbMod as any;
    const inv = await db.query.invoices.findFirst({
      where: eq(invoices.id, unlinkedInvoiceId),
    });
    expect(inv.frozen).toBe(false);
    expect(inv.balanceDue).toBe("50.00");
    expect(inv.caseDeletedNote).toBeNull();
  });

  it("void on a frozen invoice returns 409", async () => {
    const res = await request(appMod.default)
      .post(`/api/invoices/${invoiceId}/void`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ reason: "Should not work" })
      .expect(409);

    expect(res.body.message ?? res.body.error).toMatch(/frozen/i);
  });

  it("write-off on a frozen invoice returns 409", async () => {
    const res = await request(appMod.default)
      .post(`/api/invoices/${invoiceId}/write-off`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ reason: "Should not work" })
      .expect(409);

    expect(res.body.message ?? res.body.error).toMatch(/frozen/i);
  });
});
