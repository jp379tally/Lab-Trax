/**
 * Integration coverage for GET /api/cases/customer-center-summary.
 *
 * The Customer Center pages used to derive these values from the full cases
 * and invoices arrays. Keep the bounded summary endpoint equivalent for:
 * canonical cases, legacy/mobile providerless cases, providerless invoices,
 * void/paid/overdue invoices, and deposited invoices.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import request from "supertest";
import * as path from "node:path";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(require("os").tmpdir(), "labtrax-test-media-customer-center-summary"),
  extractMediaFileName: () => null,
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("Customer Center summary (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let auth: typeof import("../lib/auth.js");

  const labOwnerId = rid("cc_lab_owner");
  const providerUserId = rid("cc_provider_user");
  const outsiderId = rid("cc_outsider");
  const labOrgId = rid("cc_lab");
  const providerOrgId = rid("cc_provider");
  const otherProviderOrgId = rid("cc_other_provider");
  const canonicalCaseIds = [rid("cc_case"), rid("cc_case")];
  const legacyCaseId = rid("cc_legacy_case");
  const invoiceIds = {
    open: rid("cc_invoice"),
    paid: rid("cc_invoice"),
    overdue: rid("cc_invoice"),
    void: rid("cc_invoice"),
    providerless: rid("cc_invoice"),
    otherProvider: rid("cc_invoice"),
  };
  const bankAccountId = rid("cc_bank_account");
  const bankTransactionId = rid("cc_bank_transaction");

  async function makeSession(userId: string) {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("cc_session");
    const access = auth.signAccessToken(userId, sessionId);
    await db.insert(userSessions).values({
      id: sessionId,
      userId,
      tokenHash: createHash("sha256").update(access).digest("hex"),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    return access;
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-customer-center-summary";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    auth = await import("../lib/auth.js");

    const {
      db,
      users,
      organizations,
      organizationMemberships,
      cases,
      labCases,
      invoices,
      bankAccounts,
      bankTransactions,
      bankTransactionInvoices,
    } = dbMod as any;

    await db.insert(users).values([
      { id: labOwnerId, username: `ccowner_${labOwnerId}`, password: "x" },
      {
        id: providerUserId,
        username: `ccprovider_${providerUserId}`,
        password: "x",
        userType: "provider",
      },
      { id: outsiderId, username: `ccoutsider_${outsiderId}`, password: "x" },
    ]);
    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: rid("CustomerCenterLab") },
      {
        id: providerOrgId,
        type: "provider",
        name: rid("CustomerCenterPractice"),
        parentLabOrganizationId: labOrgId,
      },
      {
        id: otherProviderOrgId,
        type: "provider",
        name: rid("CustomerCenterOtherPractice"),
        parentLabOrganizationId: labOrgId,
      },
    ]);
    await db.insert(organizationMemberships).values([
      {
        id: rid("cc_membership"),
        labId: labOrgId,
        userId: labOwnerId,
        role: "owner",
        status: "active",
        approvedByUserId: labOwnerId,
        joinedAt: new Date(),
      },
      {
        id: rid("cc_membership"),
        labId: providerOrgId,
        userId: providerUserId,
        role: "member",
        status: "active",
        approvedByUserId: labOwnerId,
        joinedAt: new Date(),
      },
    ]);

    await db.insert(cases).values([
      {
        id: canonicalCaseIds[0],
        caseNumber: rid("CC-CANONICAL"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Canonical",
        patientLastName: "One",
        doctorName: "Dr. Canonical",
        createdByUserId: labOwnerId,
      },
      {
        id: canonicalCaseIds[1],
        caseNumber: rid("CC-CANONICAL"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Canonical",
        patientLastName: "Two",
        doctorName: "Dr. Canonical",
        createdByUserId: labOwnerId,
      },
    ]);
    await db.insert(labCases).values({
      id: legacyCaseId,
      ownerId: labOwnerId,
      organizationId: labOrgId,
      caseData: JSON.stringify({
        caseNumber: rid("CC-LEGACY"),
        patientName: "Legacy Mobile",
        doctorName: "Dr. Legacy",
        status: "DESIGN",
      }),
    });

    await db.insert(invoices).values([
      {
        id: invoiceIds.open,
        invoiceNumber: rid("CC-OPEN"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        createdByUserId: labOwnerId,
        status: "open",
        total: "100.00",
        balanceDue: "100.00",
      },
      {
        id: invoiceIds.paid,
        invoiceNumber: rid("CC-PAID"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        createdByUserId: labOwnerId,
        status: "paid",
        total: "200.00",
        balanceDue: "0.00",
      },
      {
        id: invoiceIds.overdue,
        invoiceNumber: rid("CC-OVERDUE"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        createdByUserId: labOwnerId,
        status: "overdue",
        total: "50.00",
        balanceDue: "50.00",
      },
      {
        id: invoiceIds.void,
        invoiceNumber: rid("CC-VOID"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        createdByUserId: labOwnerId,
        status: "void",
        total: "25.00",
        balanceDue: "0.00",
      },
      {
        id: invoiceIds.providerless,
        invoiceNumber: rid("CC-PROVIDERLESS"),
        labOrganizationId: labOrgId,
        providerOrganizationId: null,
        createdByUserId: labOwnerId,
        status: "open",
        total: "400.00",
        balanceDue: "400.00",
      },
      {
        id: invoiceIds.otherProvider,
        invoiceNumber: rid("CC-OTHER"),
        labOrganizationId: labOrgId,
        providerOrganizationId: otherProviderOrgId,
        createdByUserId: labOwnerId,
        status: "open",
        total: "999.00",
        balanceDue: "999.00",
      },
    ]);
    await db.insert(bankAccounts).values({
      id: bankAccountId,
      labOrganizationId: labOrgId,
      name: "Customer Center Test Account",
      createdByUserId: labOwnerId,
    });
    await db.insert(bankTransactions).values({
      id: bankTransactionId,
      labOrganizationId: labOrgId,
      bankAccountId,
      txnDate: new Date(),
      type: "deposit",
      creditAmount: "200.00",
      netAmount: "200.00",
      createdByUserId: labOwnerId,
    });
    await db.insert(bankTransactionInvoices).values({
      id: rid("cc_deposit_link"),
      bankTransactionId,
      invoiceId: invoiceIds.paid,
    });
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const {
      db,
      bankTransactionInvoices,
      bankTransactions,
      bankAccounts,
      invoices,
      cases,
      labCases,
      userSessions,
      organizationMemberships,
      organizations,
      users,
    } = dbMod as any;
    await db.delete(bankTransactionInvoices).where(
      inArray(bankTransactionInvoices.invoiceId, Object.values(invoiceIds)),
    );
    await db.delete(bankTransactions).where(eq(bankTransactions.id, bankTransactionId));
    await db.delete(bankAccounts).where(eq(bankAccounts.id, bankAccountId));
    await db.delete(invoices).where(inArray(invoices.id, Object.values(invoiceIds)));
    await db.delete(cases).where(inArray(cases.id, canonicalCaseIds));
    await db.delete(labCases).where(eq(labCases.id, legacyCaseId));
    await db.delete(userSessions).where(
      inArray(userSessions.userId, [labOwnerId, providerUserId, outsiderId]),
    );
    await db.delete(organizationMemberships).where(
      inArray(organizationMemberships.userId, [labOwnerId, providerUserId]),
    );
    await db.delete(organizations).where(
      inArray(organizations.id, [providerOrgId, otherProviderOrgId, labOrgId]),
    );
    await db.delete(users).where(
      inArray(users.id, [labOwnerId, providerUserId, outsiderId]),
    );
  });

  it("authorizes lab users and preserves legacy/providerless parity", async () => {
    const access = await makeSession(labOwnerId);
    const response = await request(appMod.default)
      .get("/api/cases/customer-center-summary")
      .set("Authorization", `Bearer ${access}`);

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([
      {
        providerOrganizationId: providerOrgId,
        caseCount: 2,
        openBalance: 150,
        totalBilled: 375,
        invoiceCount: 3,
        allPaid: false,
        allDeposited: false,
        anyOverdue: true,
      },
      {
        providerOrganizationId: otherProviderOrgId,
        caseCount: 0,
        openBalance: 999,
        totalBilled: 999,
        invoiceCount: 1,
        allPaid: false,
        allDeposited: false,
        anyOverdue: false,
      },
    ]);
  });

  it("authorizes provider users but limits them to their provider organization", async () => {
    const access = await makeSession(providerUserId);
    const response = await request(appMod.default)
      .get("/api/cases/customer-center-summary")
      .set("Authorization", `Bearer ${access}`);

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0]).toMatchObject({
      providerOrganizationId: providerOrgId,
      caseCount: 2,
      openBalance: 150,
      totalBilled: 375,
      invoiceCount: 3,
      allPaid: false,
      allDeposited: false,
      anyOverdue: true,
    });
    expect(response.body.data).not.toContainEqual(
      expect.objectContaining({ providerOrganizationId: otherProviderOrgId }),
    );
  });

  it("does not expose a summary to a user without an authorized organization", async () => {
    const access = await makeSession(outsiderId);
    const response = await request(appMod.default)
      .get("/api/cases/customer-center-summary")
      .set("Authorization", `Bearer ${access}`);

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([]);
  });
});