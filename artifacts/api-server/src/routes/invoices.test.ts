/**
 * Integration tests for invoice routes (regression guard).
 *
 * Skipped when DATABASE_URL is not configured. All inserted rows are removed
 * in afterAll so the suite is safe to run against a shared dev DB.
 *
 * Coverage:
 *  - POST /api/invoices — creates an open invoice (201)
 *  - GET /api/invoices — returned list includes the created invoice
 *  - POST /api/invoices — 403 when caller is not a lab member
 *  - Unauthenticated requests return 401
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { and, inArray, eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import request from "supertest";
import * as path from "node:path";
import { cleanupPaymentFixtures } from "../test-utils/payment-cleanup.js";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/statements.js")>()),
  startStatementScheduler: vi.fn(),
}));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(require("os").tmpdir(), "labtrax-test-media-invoices"),
  extractMediaFileName: () => null,
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("Invoices (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let authLib: typeof import("../lib/auth.js");

  const labOwnerId = rid("u");
  const billingUserId = rid("billing");
  const outsiderId = rid("out");
  const labOrgId = rid("lab");
  const providerOrgId = rid("prov");

  async function makeSession(userId: string): Promise<{ access: string; refresh: string }> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const refresh = authLib.signRefreshToken(userId, sessionId);
    const hash = createHash("sha256").update(refresh).digest("hex");
    await db.insert(userSessions).values({ id: sessionId, userId, tokenHash: hash, expiresAt });
    const access = authLib.signAccessToken(userId, sessionId);
    return { access, refresh };
  }

  type InvoiceReadParityFixture = {
    mixedIdentityId: string;
    directAllowedProviderUserId: string;
    directDeniedProviderUserId: string;
    labOrganizationId: string;
    ownPracticeId: string;
    allowedProviderPracticeId: string;
    deniedProviderPracticeId: string;
    unrelatedPracticeId: string;
    invoiceIds: {
      lab: string;
      allowedProvider: string;
      deniedProvider: string;
      unrelated: string;
    };
    attachmentIds: {
      allowedProvider: string;
    };
    mobileInvoiceIds: {
      allowedProvider: string;
      deniedProvider: string;
    };
    paymentIds: {
      lab: string;
      allowedProvider: string;
      deniedProvider: string;
      unrelated: string;
    };
    recentTransactionIds: {
      lab: string;
    };
    practiceStatementIds: {
      allowedProvider: string;
      deniedProvider: string;
      unrelated: string;
    };
    bankTransactionIds: {
      allowedProvider: string;
      deniedProvider: string;
    };
    cleanup: () => Promise<void>;
  };

  /**
   * Keep the authorization matrix independent from the suite's broad invoice
   * fixture. The mixed lab identity is linked to one billing-capable provider
   * and one basic-plan provider so a route must both include the allowed
   * provider organization and exclude the denied one.
   */
  async function createInvoiceReadParityFixture(): Promise<InvoiceReadParityFixture> {
    const {
      db,
      users,
      organizations,
      organizationMemberships,
      doctorAccountLinks,
      subscriptions,
      invoices,
      invoiceAttachments,
      labCases,
      payments,
      bankAccounts,
      bankTransactions,
      bankTransactionInvoices,
      practiceStatements,
      userSessions,
    } = dbMod as any;

    const mixedIdentityId = rid("invoice_parity_lab_user");
    const allowedProviderUserId = rid("invoice_parity_allowed_provider");
    const deniedProviderUserId = rid("invoice_parity_denied_provider");
    const directAllowedProviderUserId = rid(
      "invoice_parity_direct_allowed_provider",
    );
    const directDeniedProviderUserId = rid(
      "invoice_parity_direct_denied_provider",
    );
    const unrelatedUserId = rid("invoice_parity_unrelated_user");
    const labOrganizationId = rid("invoice_parity_lab");
    const linkedAllowedLabId = rid("invoice_parity_allowed_lab");
    const linkedDeniedLabId = rid("invoice_parity_denied_lab");
    const unrelatedLabId = rid("invoice_parity_unrelated_lab");
    const ownPracticeId = rid("invoice_parity_own_practice");
    const allowedProviderPracticeId = rid("invoice_parity_allowed_practice");
    const deniedProviderPracticeId = rid("invoice_parity_denied_practice");
    const unrelatedPracticeId = rid("invoice_parity_unrelated_practice");

    const userIds = [
      mixedIdentityId,
      allowedProviderUserId,
      deniedProviderUserId,
      directAllowedProviderUserId,
      directDeniedProviderUserId,
      unrelatedUserId,
    ];
    const organizationIds = [
      labOrganizationId,
      linkedAllowedLabId,
      linkedDeniedLabId,
      unrelatedLabId,
      ownPracticeId,
      allowedProviderPracticeId,
      deniedProviderPracticeId,
      unrelatedPracticeId,
    ];
    const invoiceIds = {
      lab: rid("invoice_parity_lab_invoice"),
      allowedProvider: rid("invoice_parity_allowed_invoice"),
      deniedProvider: rid("invoice_parity_denied_invoice"),
      unrelated: rid("invoice_parity_unrelated_invoice"),
    };
    const mobileInvoiceIds = {
      allowedProvider: rid("invoice_parity_allowed_mobile_invoice"),
      deniedProvider: rid("invoice_parity_denied_mobile_invoice"),
    };
    const mobileCaseIds = {
      allowedProvider: rid("invoice_parity_allowed_mobile_case"),
      deniedProvider: rid("invoice_parity_denied_mobile_case"),
    };
    const mobileCaseNumbers = {
      allowedProvider: rid("INVOICE_PARITY_ALLOWED_MOBILE_CASE"),
      deniedProvider: rid("INVOICE_PARITY_DENIED_MOBILE_CASE"),
    };
    const paymentIds = {
      lab: rid("invoice_parity_lab_payment"),
      allowedProvider: rid("invoice_parity_allowed_payment"),
      deniedProvider: rid("invoice_parity_denied_payment"),
      unrelated: rid("invoice_parity_unrelated_payment"),
    };
    const recentTransactionIds = {
      lab: rid("invoice_parity_lab_transaction"),
    };
    const recentAccountId = rid("invoice_parity_bank_account");
    const attachmentIds = {
      allowedProvider: rid("invoice_parity_allowed_attachment"),
    };
    const practiceStatementIds = {
      allowedProvider: rid("invoice_parity_allowed_statement"),
      deniedProvider: rid("invoice_parity_denied_statement"),
      unrelated: rid("invoice_parity_unrelated_statement"),
    };
    const bankTransactionIds = {
      allowedProvider: rid("invoice_parity_allowed_transaction"),
      deniedProvider: rid("invoice_parity_denied_transaction"),
    };

    await db.insert(users).values([
      {
        id: mixedIdentityId,
        username: `invoice_parity_lab_${mixedIdentityId}`,
        password: "x",
        userType: "lab",
      },
      {
        id: allowedProviderUserId,
        username: `invoice_parity_allowed_${allowedProviderUserId}`,
        password: "x",
        userType: "provider",
      },
      {
        id: deniedProviderUserId,
        username: `invoice_parity_denied_${deniedProviderUserId}`,
        password: "x",
        userType: "provider",
      },
      {
        id: directAllowedProviderUserId,
        username: `invoice_parity_direct_allowed_${directAllowedProviderUserId}`,
        password: "x",
        userType: "provider",
      },
      {
        id: directDeniedProviderUserId,
        username: `invoice_parity_direct_denied_${directDeniedProviderUserId}`,
        password: "x",
        userType: "provider",
      },
      {
        id: unrelatedUserId,
        username: `invoice_parity_unrelated_${unrelatedUserId}`,
        password: "x",
        userType: "lab",
      },
    ]);

    await db.insert(organizations).values([
      { id: labOrganizationId, type: "lab", name: "Invoice parity lab" },
      {
        id: linkedAllowedLabId,
        type: "lab",
        name: "Invoice parity allowed lab",
      },
      {
        id: linkedDeniedLabId,
        type: "lab",
        name: "Invoice parity denied lab",
      },
      {
        id: unrelatedLabId,
        type: "lab",
        name: "Invoice parity unrelated lab",
      },
      {
        id: ownPracticeId,
        type: "provider",
        name: "Invoice parity own practice",
        parentLabOrganizationId: labOrganizationId,
      },
      {
        id: allowedProviderPracticeId,
        type: "provider",
        name: "Invoice parity allowed practice",
        parentLabOrganizationId: linkedAllowedLabId,
      },
      {
        id: deniedProviderPracticeId,
        type: "provider",
        name: "Invoice parity denied practice",
        parentLabOrganizationId: linkedDeniedLabId,
      },
      {
        id: unrelatedPracticeId,
        type: "provider",
        name: "Invoice parity unrelated practice",
        parentLabOrganizationId: unrelatedLabId,
      },
    ]);

    await db.insert(organizationMemberships).values([
      {
        id: rid("invoice_parity_membership"),
        labId: labOrganizationId,
        userId: mixedIdentityId,
        role: "owner",
        status: "active",
        approvedByUserId: mixedIdentityId,
        joinedAt: new Date(),
      },
      {
        id: rid("invoice_parity_membership"),
        labId: allowedProviderPracticeId,
        userId: allowedProviderUserId,
        role: "owner",
        status: "active",
        approvedByUserId: allowedProviderUserId,
        joinedAt: new Date(),
      },
      {
        id: rid("invoice_parity_membership"),
        labId: deniedProviderPracticeId,
        userId: deniedProviderUserId,
        role: "owner",
        status: "active",
        approvedByUserId: deniedProviderUserId,
        joinedAt: new Date(),
      },
      {
        id: rid("invoice_parity_membership"),
        labId: allowedProviderPracticeId,
        userId: directAllowedProviderUserId,
        role: "owner",
        status: "active",
        approvedByUserId: directAllowedProviderUserId,
        joinedAt: new Date(),
      },
      {
        id: rid("invoice_parity_membership"),
        labId: deniedProviderPracticeId,
        userId: directDeniedProviderUserId,
        role: "owner",
        status: "active",
        approvedByUserId: directDeniedProviderUserId,
        joinedAt: new Date(),
      },
      {
        id: rid("invoice_parity_membership"),
        labId: unrelatedLabId,
        userId: unrelatedUserId,
        role: "owner",
        status: "active",
        approvedByUserId: unrelatedUserId,
        joinedAt: new Date(),
      },
    ]);

    const linkPair = (left: string, right: string) =>
      left < right
        ? { userIdLow: left, userIdHigh: right }
        : { userIdLow: right, userIdHigh: left };
    await db.insert(doctorAccountLinks).values([
      {
        id: rid("invoice_parity_link"),
        ...linkPair(mixedIdentityId, allowedProviderUserId),
        linkedVia: "admin_backfill",
      },
      {
        id: rid("invoice_parity_link"),
        ...linkPair(mixedIdentityId, deniedProviderUserId),
        linkedVia: "admin_backfill",
      },
    ]);

    await db.insert(subscriptions).values([
      {
        id: rid("invoice_parity_subscription"),
        subjectType: "provider_org",
        subjectId: allowedProviderPracticeId,
        provider: "test",
        status: "active",
        planType: "provider",
        providerPlan: "standard",
      },
      {
        id: rid("invoice_parity_subscription"),
        subjectType: "provider_org",
        subjectId: deniedProviderPracticeId,
        provider: "test",
        status: "active",
        planType: "provider",
        providerPlan: "basic",
      },
    ]);

    await db.insert(invoices).values([
      {
        id: invoiceIds.lab,
        invoiceNumber: rid("INVOICE_PARITY_LAB"),
        labOrganizationId,
        providerOrganizationId: ownPracticeId,
        status: "open",
        displayMetadataJson: { billTo: "Dr Invoice Parity Lab" },
        createdByUserId: mixedIdentityId,
      },
      {
        id: invoiceIds.allowedProvider,
        invoiceNumber: `INV-${mobileCaseNumbers.allowedProvider}`,
        labOrganizationId: linkedAllowedLabId,
        providerOrganizationId: allowedProviderPracticeId,
        status: "open",
        total: "25.00",
        balanceDue: "25.00",
        displayMetadataJson: { billTo: "Dr Invoice Parity Allowed" },
        createdByUserId: allowedProviderUserId,
      },
      {
        id: invoiceIds.deniedProvider,
        invoiceNumber: `INV-${mobileCaseNumbers.deniedProvider}`,
        labOrganizationId: linkedDeniedLabId,
        providerOrganizationId: deniedProviderPracticeId,
        status: "open",
        total: "95.00",
        balanceDue: "95.00",
        displayMetadataJson: { billTo: "Dr Invoice Parity Denied" },
        createdByUserId: deniedProviderUserId,
      },
      {
        id: invoiceIds.unrelated,
        invoiceNumber: rid("INVOICE_PARITY_UNRELATED"),
        labOrganizationId: unrelatedLabId,
        providerOrganizationId: unrelatedPracticeId,
        status: "open",
        total: "125.00",
        balanceDue: "125.00",
        displayMetadataJson: { billTo: "Dr Invoice Parity Unrelated" },
        createdByUserId: unrelatedUserId,
      },
    ]);
    await db.insert(invoiceAttachments).values({
      id: attachmentIds.allowedProvider,
      invoiceId: invoiceIds.allowedProvider,
      fileName: "invoice-parity.txt",
      storageKey: "/uploads/invoice-attachments/invoice-parity.txt",
      fileType: "text/plain",
      fileSize: 12,
      includeInPdf: false,
      uploadedByUserId: allowedProviderUserId,
    });
    await db.insert(practiceStatements).values([
      {
        id: practiceStatementIds.allowedProvider,
        labOrganizationId: linkedAllowedLabId,
        providerOrganizationId: allowedProviderPracticeId,
        periodStart: new Date("2099-01-01T00:00:00.000Z"),
        periodEnd: new Date("2099-01-31T23:59:59.000Z"),
        invoiceCount: 1,
        totalBilled: "25.00",
        totalPaid: "0.00",
        balanceDue: "25.00",
        invoiceIdsJson: [invoiceIds.allowedProvider],
        createdByUserId: allowedProviderUserId,
      },
      {
        id: practiceStatementIds.deniedProvider,
        labOrganizationId: linkedDeniedLabId,
        providerOrganizationId: deniedProviderPracticeId,
        periodStart: new Date("2099-01-01T00:00:00.000Z"),
        periodEnd: new Date("2099-01-31T23:59:59.000Z"),
        invoiceCount: 1,
        totalBilled: "95.00",
        totalPaid: "0.00",
        balanceDue: "95.00",
        invoiceIdsJson: [invoiceIds.deniedProvider],
        createdByUserId: deniedProviderUserId,
      },
      {
        id: practiceStatementIds.unrelated,
        labOrganizationId: unrelatedLabId,
        providerOrganizationId: unrelatedPracticeId,
        periodStart: new Date("2099-01-01T00:00:00.000Z"),
        periodEnd: new Date("2099-01-31T23:59:59.000Z"),
        invoiceCount: 1,
        totalBilled: "125.00",
        totalPaid: "0.00",
        balanceDue: "125.00",
        invoiceIdsJson: [invoiceIds.unrelated],
        createdByUserId: unrelatedUserId,
      },
    ]);
    await db.insert(labCases).values([
      {
        id: mobileCaseIds.allowedProvider,
        ownerId: allowedProviderUserId,
        organizationId: linkedAllowedLabId,
        caseData: JSON.stringify({
          caseNumber: mobileCaseNumbers.allowedProvider,
          invoiceId: mobileInvoiceIds.allowedProvider,
          patientName: "Invoice Parity Allowed Mobile Patient",
          price: 125,
        }),
      },
      {
        id: mobileCaseIds.deniedProvider,
        ownerId: deniedProviderUserId,
        organizationId: linkedDeniedLabId,
        caseData: JSON.stringify({
          caseNumber: mobileCaseNumbers.deniedProvider,
          invoiceId: mobileInvoiceIds.deniedProvider,
          patientName: "Invoice Parity Denied Mobile Patient",
          price: 125,
        }),
      },
    ]);
    await db.insert(payments).values([
      {
        id: paymentIds.lab,
        invoiceId: invoiceIds.lab,
        amount: "11.00",
        paymentMethod: "cash",
        recordedByUserId: mixedIdentityId,
      },
      {
        id: paymentIds.allowedProvider,
        invoiceId: invoiceIds.allowedProvider,
        amount: "12.00",
        paymentMethod: "check",
        recordedByUserId: allowedProviderUserId,
      },
      {
        id: paymentIds.deniedProvider,
        invoiceId: invoiceIds.deniedProvider,
        amount: "13.00",
        paymentMethod: "cash",
        recordedByUserId: deniedProviderUserId,
      },
      {
        id: paymentIds.unrelated,
        invoiceId: invoiceIds.unrelated,
        amount: "14.00",
        paymentMethod: "other",
        recordedByUserId: unrelatedUserId,
      },
    ]);
    await db.insert(bankAccounts).values({
      id: recentAccountId,
      labOrganizationId,
      name: "Invoice parity checking",
    });
    await db.insert(bankTransactions).values([
      {
        id: recentTransactionIds.lab,
        labOrganizationId,
        bankAccountId: recentAccountId,
        txnDate: new Date(),
        type: "deposit",
        creditAmount: "11.00",
        netAmount: "11.00",
        source: "invoice",
        status: "posted",
        createdByUserId: mixedIdentityId,
      },
      {
        id: bankTransactionIds.allowedProvider,
        labOrganizationId,
        bankAccountId: recentAccountId,
        txnDate: new Date(),
        type: "deposit",
        creditAmount: "12.00",
        netAmount: "12.00",
        source: "invoice",
        status: "posted",
        createdByUserId: mixedIdentityId,
      },
      {
        id: bankTransactionIds.deniedProvider,
        labOrganizationId,
        bankAccountId: recentAccountId,
        txnDate: new Date(),
        type: "deposit",
        creditAmount: "13.00",
        netAmount: "13.00",
        source: "invoice",
        status: "posted",
        createdByUserId: mixedIdentityId,
      },
    ]);
    await db.insert(bankTransactionInvoices).values([
      {
        id: rid("invoice_parity_transaction_link"),
        bankTransactionId: recentTransactionIds.lab,
        invoiceId: invoiceIds.lab,
      },
      {
        id: rid("invoice_parity_transaction_invoice"),
        bankTransactionId: bankTransactionIds.allowedProvider,
        invoiceId: invoiceIds.allowedProvider,
      },
      {
        id: rid("invoice_parity_transaction_invoice"),
        bankTransactionId: bankTransactionIds.deniedProvider,
        invoiceId: invoiceIds.deniedProvider,
      },
    ]);

    return {
      mixedIdentityId,
      directAllowedProviderUserId,
      directDeniedProviderUserId,
      labOrganizationId,
      ownPracticeId,
      allowedProviderPracticeId,
      deniedProviderPracticeId,
      unrelatedPracticeId,
      invoiceIds,
      attachmentIds,
      mobileInvoiceIds,
      paymentIds,
      recentTransactionIds,
      practiceStatementIds,
      bankTransactionIds,
      cleanup: async () => {
        const recentPaymentTransactionIds = [
          ...Object.values(recentTransactionIds),
          ...Object.values(bankTransactionIds),
        ];
        await db.delete(bankTransactionInvoices).where(
          inArray(
            bankTransactionInvoices.bankTransactionId,
            recentPaymentTransactionIds,
          ),
        );
        await db.delete(bankTransactions).where(
          inArray(bankTransactions.id, recentPaymentTransactionIds),
        );
        await db.delete(bankAccounts).where(eq(bankAccounts.id, recentAccountId));
        await cleanupPaymentFixtures(
          { invoiceIds: Object.values(invoiceIds) },
          db,
        );
        await db.delete(invoiceAttachments).where(
          inArray(invoiceAttachments.id, Object.values(attachmentIds)),
        );
        await db.delete(practiceStatements).where(
          inArray(practiceStatements.id, Object.values(practiceStatementIds)),
        );
        await db.delete(invoices).where(inArray(invoices.id, Object.values(invoiceIds)));
        await db.delete(labCases).where(
          inArray(labCases.id, Object.values(mobileCaseIds)),
        );
        await db.delete(subscriptions).where(
          inArray(subscriptions.subjectId, [
            allowedProviderPracticeId,
            deniedProviderPracticeId,
          ]),
        );
        await db.delete(doctorAccountLinks).where(
          inArray(doctorAccountLinks.userIdLow, userIds),
        );
        await db.delete(doctorAccountLinks).where(
          inArray(doctorAccountLinks.userIdHigh, userIds),
        );
        await db.delete(userSessions).where(
          inArray(userSessions.userId, userIds),
        );
        await db.delete(organizationMemberships).where(
          inArray(organizationMemberships.userId, userIds),
        );
        await db.delete(organizations).where(inArray(organizations.id, organizationIds));
        await db.delete(users).where(inArray(users.id, userIds));
      },
    };
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-invoices";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    authLib = await import("../lib/auth.js");

    const { db, users, organizations, organizationMemberships } = dbMod as any;

    await db.insert(users).values([
      { id: labOwnerId, username: `invowner_${labOwnerId}`, password: "x" },
      { id: billingUserId, username: `invbilling_${billingUserId}`, password: "x" },
      { id: outsiderId, username: `invout_${outsiderId}`, password: "x" },
    ]);

    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: rid("InvTestLab") },
      {
        id: providerOrgId,
        type: "provider",
        name: rid("InvTestPractice"),
        parentLabOrganizationId: labOrgId,
      },
    ]);

    await db.insert(organizationMemberships).values([
      {
        id: rid("m"),
        labId: labOrgId,
        userId: labOwnerId,
        role: "owner",
        status: "active",
        approvedByUserId: labOwnerId,
        joinedAt: new Date(),
      },
      {
        id: rid("m"),
        labId: labOrgId,
        userId: billingUserId,
        role: "billing",
        status: "active",
        approvedByUserId: labOwnerId,
        joinedAt: new Date(),
      },
    ]);
  });

  // Ensure a fresh session exists before each test; per-test sessions created
  // in each it() body are still the authoritative token for that test.
  beforeEach(async () => {
    await makeSession(labOwnerId);
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const {
      db,
      auditLogs,
      invoiceLineItems,
      invoices,
      labCases,
      userSessions,
      organizationMemberships,
      organizations,
      users,
    } = dbMod as any;

    if (labCases) {
      await db.delete(labCases).where(inArray(labCases.organizationId, [labOrgId, providerOrgId]));
    }
    await db.delete(auditLogs).where(inArray(auditLogs.organizationId, [labOrgId, providerOrgId]));
    if (invoiceLineItems) {
      await db.delete(invoiceLineItems).where(
        inArray(
          invoiceLineItems.invoiceId,
          (await db.select({ id: invoices.id }).from(invoices).where(
            inArray(invoices.labOrganizationId, [labOrgId])
          )).map((r: any) => r.id)
        )
      );
    }
    await db.delete(invoices).where(inArray(invoices.labOrganizationId, [labOrgId]));
    await db.delete(userSessions).where(
      inArray(userSessions.userId, [labOwnerId, billingUserId, outsiderId])
    );
    await db.delete(organizationMemberships).where(
      inArray(organizationMemberships.userId, [labOwnerId, billingUserId, outsiderId])
    );
    await db.delete(organizations).where(eq(organizations.id, providerOrgId));
    await db.delete(organizations).where(eq(organizations.id, labOrgId));
    await db.delete(users).where(inArray(users.id, [labOwnerId, billingUserId, outsiderId]));
  });

  // ── POST /api/invoices ────────────────────────────────────────────────────

  it("POST /api/invoices creates an open invoice and returns 201", async () => {
    const { access } = await makeSession(labOwnerId);
    const invoiceNumber = rid("INV");

    const r = await request(appMod.default)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${access}`)
      .send({
        invoiceNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
      });

    expect(r.status).toBe(201);
    expect(r.body.data).toBeDefined();
    expect(r.body.data.invoiceNumber).toBe(invoiceNumber);
    expect(r.body.data.status).toBe("open");
    expect(r.body.data.labOrganizationId).toBe(labOrgId);
  });

  it("POST /api/invoices without required fields returns 400", async () => {
    const { access } = await makeSession(labOwnerId);

    const r = await request(appMod.default)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${access}`)
      .send({ labOrganizationId: labOrgId });

    expect(r.status).toBe(400);
  });

  it("POST /api/invoices as non-member returns 403", async () => {
    const { access } = await makeSession(outsiderId);

    const r = await request(appMod.default)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${access}`)
      .send({
        invoiceNumber: rid("INV"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
      });

    expect(r.status).toBe(403);
  });

  it("unauthenticated POST /api/invoices returns 401", async () => {
    const r = await request(appMod.default)
      .post("/api/invoices")
      .send({
        invoiceNumber: rid("INV"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
      });
    expect(r.status).toBe(401);
  });

  // ── PATCH /api/invoices/:id (status transition) ───────────────────────────

  it("PATCH /api/invoices/:id updates status to open", async () => {
    const { access } = await makeSession(labOwnerId);
    const invoiceNumber = rid("PATCHINV");

    const create = await request(appMod.default)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${access}`)
      .send({
        invoiceNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
      });
    expect(create.status).toBe(201);
    const invoiceId = create.body.data.id;

    const patch = await request(appMod.default)
      .patch(`/api/invoices/${invoiceId}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ status: "open" });
    expect(patch.status).toBe(200);
    expect(patch.body.data?.status ?? patch.body.status).toBe("open");
  });

  it("PATCH /api/invoices/:id preserves canonical issue and due timestamps", async () => {
    const { access } = await makeSession(labOwnerId);
    const create = await request(appMod.default)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${access}`)
      .send({
        invoiceNumber: rid("DATEPATCH"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
      });
    expect(create.status).toBe(201);

    const issuedAt = "2026-01-15T00:00:00.000Z";
    const dueAt = "2026-02-15T00:00:00.000Z";
    const patch = await request(appMod.default)
      .patch(`/api/invoices/${create.body.data.id}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ issuedAt, dueAt });

    expect(patch.status).toBe(200);
    expect(patch.body.data.issuedAt).toBe(issuedAt);
    expect(patch.body.data.dueAt).toBe(dueAt);

    const get = await request(appMod.default)
      .get(`/api/invoices/${create.body.data.id}`)
      .set("Authorization", `Bearer ${access}`);
    expect(get.status).toBe(200);
    expect(get.body.data.issuedAt).toBe(issuedAt);
    expect(get.body.data.dueAt).toBe(dueAt);
  });

  it("PATCH /api/invoices/:id/repair-dates changes only dates and audits the repair", async () => {
    const { access } = await makeSession(labOwnerId);
    const { db, invoices, auditLogs } = dbMod as any;
    const invoiceNumber = rid("DATEREPAIR");
    const create = await request(appMod.default)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${access}`)
      .send({
        invoiceNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        notes: "keep this note",
      });
    expect(create.status).toBe(201);
    const invoiceId = create.body.data.id;
    const setNote = await request(appMod.default)
      .patch(`/api/invoices/${invoiceId}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ notes: "keep this note" });
    expect(setNote.status).toBe(200);
    await db
      .update(invoices)
      .set({
        issuedAt: new Date("2026-01-15T05:00:00.000Z"),
        dueAt: new Date("2026-02-15T05:00:00.000Z"),
        createdAt: new Date("2026-09-10T12:00:00.000Z"),
      })
      .where(eq(invoices.id, invoiceId));

    const repair = await request(appMod.default)
      .patch(`/api/invoices/${invoiceId}/repair-dates`)
      .set("Authorization", `Bearer ${access}`)
      .send({
        issuedAt: "2026-01-15T00:00:00.000Z",
        dueAt: "2026-02-15T00:00:00.000Z",
      });

    expect(repair.status).toBe(200);
    expect(repair.body.data.issuedAt).toBe("2026-01-15T00:00:00.000Z");
    expect(repair.body.data.dueAt).toBe("2026-02-15T00:00:00.000Z");
    expect(repair.body.data.invoiceNumber).toBe(invoiceNumber);
    expect(repair.body.data.notes).toBe("keep this note");

    const audit = await db.query.auditLogs.findFirst({
      where: eq(auditLogs.entityId, invoiceId),
      orderBy: (rows: any, { desc }: any) => [desc(rows.createdAt)],
    });
    expect(audit.action).toBe("invoice_dates_repaired");
    expect(audit.beforeJson).toEqual({
      issuedAt: "2026-01-15T05:00:00.000Z",
      dueAt: "2026-02-15T05:00:00.000Z",
    });
    expect(audit.afterJson).toEqual({
      issuedAt: "2026-01-15T00:00:00.000Z",
      dueAt: "2026-02-15T00:00:00.000Z",
    });

    const detail = await request(appMod.default)
      .get(`/api/invoices/${invoiceId}`)
      .set("Authorization", `Bearer ${access}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.dateRepairLogs).toEqual([
      expect.objectContaining({
        id: audit.id,
        userId: labOwnerId,
        actorUsername: `invowner_${labOwnerId}`,
        beforeJson: {
          issuedAt: "2026-01-15T05:00:00.000Z",
          dueAt: "2026-02-15T05:00:00.000Z",
        },
        afterJson: {
          issuedAt: "2026-01-15T00:00:00.000Z",
          dueAt: "2026-02-15T00:00:00.000Z",
        },
      }),
    ]);

  });

  it("PATCH /api/invoices/:id/repair-dates rejects current invoices and billing users", async () => {
    const { access } = await makeSession(labOwnerId);
    const create = await request(appMod.default)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${access}`)
      .send({
        invoiceNumber: rid("DATEREPAIRGUARD"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        issuedAt: "2026-03-10T00:00:00.000Z",
        dueAt: "2026-04-10T00:00:00.000Z",
      });
    expect(create.status).toBe(201);

    const currentInvoice = await request(appMod.default)
      .patch(`/api/invoices/${create.body.data.id}/repair-dates`)
      .set("Authorization", `Bearer ${access}`)
      .send({
        issuedAt: "2026-03-09T00:00:00.000Z",
        dueAt: "2026-04-09T00:00:00.000Z",
      });
    expect(currentInvoice.status).toBe(400);

    const { db, invoices } = dbMod as any;
    await db
      .update(invoices)
      .set({
        issuedAt: new Date("2026-03-10T05:00:00.000Z"),
        dueAt: new Date("2026-04-10T05:00:00.000Z"),
        createdAt: new Date("2026-09-10T12:00:00.000Z"),
      })
      .where(eq(invoices.id, create.body.data.id));

    const nullRepair = await request(appMod.default)
      .patch(`/api/invoices/${create.body.data.id}/repair-dates`)
      .set("Authorization", `Bearer ${access}`)
      .send({
        issuedAt: null,
        dueAt: "2026-04-10T00:00:00.000Z",
      });
    expect(nullRepair.status).toBe(400);

    const billingSession = await makeSession(billingUserId);
    const forbidden = await request(appMod.default)
      .patch(`/api/invoices/${create.body.data.id}/repair-dates`)
      .set("Authorization", `Bearer ${billingSession.access}`)
      .send({
        issuedAt: "2026-03-09T00:00:00.000Z",
        dueAt: "2026-04-09T00:00:00.000Z",
      });
    expect(forbidden.status).toBe(403);

    const bypass = await request(appMod.default)
      .patch(`/api/invoices/${create.body.data.id}`)
      .set("Authorization", `Bearer ${billingSession.access}`)
      .send({ issuedAt: "2026-03-09T00:00:00.000Z" });
    expect(bypass.status).toBe(409);
  });

  it("PATCH /api/invoices/:id/repair-doctor explicitly assigns a same-practice profile and audits it", async () => {
    const { access: ownerAccess } = await makeSession(labOwnerId);
    const billingSession = await makeSession(billingUserId);
    const { db, doctorProfiles, auditLogs } = dbMod as any;
    const profileId = rid("doctor-profile");
    const wrongPracticeProfileId = rid("doctor-profile-other-practice");
    await db.insert(doctorProfiles).values({
      id: profileId,
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      doctorName: "Dr. Legacy Repair",
      displayName: "Dr. Legacy Repair",
    });
    await db.insert(doctorProfiles).values({
      id: wrongPracticeProfileId,
      labOrganizationId: labOrgId,
      providerOrganizationId: null,
      doctorName: "Dr. Wrong Practice",
      displayName: "Dr. Wrong Practice",
    });

    const create = await request(appMod.default)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${ownerAccess}`)
      .send({
        invoiceNumber: rid("LEGACYDOCTOR"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
      });
    expect(create.status).toBe(201);
    const invoiceId = create.body.data.id;

    const forbidden = await request(appMod.default)
      .patch(`/api/invoices/${invoiceId}/repair-doctor`)
      .set("Authorization", `Bearer ${billingSession.access}`)
      .send({ doctorProfileId: profileId });
    expect(forbidden.status).toBe(403);

    const wrongPractice = await request(appMod.default)
      .patch(`/api/invoices/${invoiceId}/repair-doctor`)
      .set("Authorization", `Bearer ${ownerAccess}`)
      .send({ doctorProfileId: wrongPracticeProfileId });
    expect(wrongPractice.status).toBe(400);

    const repaired = await request(appMod.default)
      .patch(`/api/invoices/${invoiceId}/repair-doctor`)
      .set("Authorization", `Bearer ${ownerAccess}`)
      .send({ doctorProfileId: profileId });
    expect(repaired.status).toBe(200);
    expect(repaired.body.data.doctorIdentity).toBe(profileId);

    const detail = await request(appMod.default)
      .get(`/api/invoices/${invoiceId}`)
      .set("Authorization", `Bearer ${ownerAccess}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.doctorIdentityRepairLogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          afterJson: expect.objectContaining({ doctorIdentity: profileId }),
          metadataJson: expect.objectContaining({
            doctorProfileId: profileId,
            reason: "explicit_admin_legacy_invoice_repair",
          }),
        }),
      ]),
    );

    const secondRepair = await request(appMod.default)
      .patch(`/api/invoices/${invoiceId}/repair-doctor`)
      .set("Authorization", `Bearer ${ownerAccess}`)
      .send({ doctorProfileId: profileId });
    expect(secondRepair.status).toBe(409);

    const audit = await db.query.auditLogs.findFirst({
      where: and(
        eq(auditLogs.entityId, invoiceId),
        eq(auditLogs.action, "invoice_doctor_identity_repaired"),
      ),
    });
    expect(audit?.afterJson).toEqual(
      expect.objectContaining({ doctorIdentity: profileId }),
    );
  });

  it("GET /api/invoices as non-lab-member returns 200 with no results for that lab", async () => {
    // The list endpoint filters by the caller's own memberships, so a user with
    // no membership in labOrgId gets 200 with an empty result set — not a 403.
    // This is the cross-lab scoping guarantee: non-members cannot see other labs' invoices.
    const { access } = await makeSession(outsiderId);

    const r = await request(appMod.default)
      .get(`/api/invoices?labOrganizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    const list: any[] = r.body.data ?? [];
    expect(list.length).toBe(0);
  });

  // ── PATCH /api/invoices/:id — line items ─────────────────────────────────

  it("PATCH /api/invoices/:id with items array stores line items (subtotal reflects them)", async () => {
    const { access } = await makeSession(labOwnerId);
    const invoiceNumber = rid("LIINV");

    const create = await request(appMod.default)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${access}`)
      .send({
        invoiceNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
      });
    expect(create.status).toBe(201);
    const invoiceId = create.body.data.id;

    const patch = await request(appMod.default)
      .patch(`/api/invoices/${invoiceId}`)
      .set("Authorization", `Bearer ${access}`)
      .send({
        items: [
          { description: "PFM Crown", quantity: 1, unitPrice: 150 },
          { description: "Porcelain Veneer", quantity: 2, unitPrice: 75 },
        ],
      });
    expect(patch.status).toBe(200);
    // 150*1 + 75*2 = 300
    const subtotal = Number(
      patch.body.data?.subtotal ?? patch.body.subtotal ?? 0
    );
    expect(subtotal).toBeCloseTo(300, 1);
  });

  it("stores fixed discount lines as signed deductions and refuses totals below zero or payments", async () => {
    const { db, payments, invoiceLineItems } = dbMod as any;
    const { access } = await makeSession(labOwnerId);
    const create = await request(appMod.default)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${access}`)
      .send({
        invoiceNumber: rid("DISCOUNTINV"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
      });
    expect(create.status).toBe(201);
    const invoiceId = create.body.data.id as string;
    const accepted = await request(appMod.default)
      .patch(`/api/invoices/${invoiceId}`)
      .set("Authorization", `Bearer ${access}`)
      .send({
        items: [
          { description: "Crown", quantity: 1, unitPrice: 500 },
          { description: "Discount", quantity: 1, unitPrice: -400, isDiscount: true },
        ],
      });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(Number(accepted.body.data.subtotal)).toBe(100);
    expect(Number(accepted.body.data.total)).toBe(100);
    expect(Number(accepted.body.data.balanceDue)).toBe(100);
    const storedLines = await db
      .select()
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, invoiceId));
    expect(storedLines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          description: "Discount",
          unitPrice: "-400.00",
          lineTotal: "-400.00",
          isDiscount: true,
        }),
      ]),
    );

    const negativeCharge = await request(appMod.default)
      .patch(`/api/invoices/${invoiceId}`)
      .set("Authorization", `Bearer ${access}`)
      .send({
        items: [{ description: "Invalid charge", quantity: 1, unitPrice: -1 }],
      });
    expect(negativeCharge.status).toBe(400);
    expect(JSON.stringify(negativeCharge.body)).toContain(
      "Charge line amounts cannot be negative",
    );

    const belowZero = await request(appMod.default)
      .patch(`/api/invoices/${invoiceId}`)
      .set("Authorization", `Bearer ${access}`)
      .send({
        items: [
          { description: "Crown", quantity: 1, unitPrice: 500 },
          { description: "Discount", quantity: 1, unitPrice: -600, isDiscount: true },
        ],
      });
    expect(belowZero.status).toBe(409);
    expect(JSON.stringify(belowZero.body)).toContain(
      "below $0.00",
    );

    const paymentId = rid("discount-payment");
    try {
      await db.insert(payments).values({
        id: paymentId,
        invoiceId,
        amount: "80.00",
        paymentMethod: "cash",
        recordedByUserId: labOwnerId,
      });
      const belowPaid = await request(appMod.default)
        .patch(`/api/invoices/${invoiceId}`)
        .set("Authorization", `Bearer ${access}`)
        .send({
          items: [
            { description: "Crown", quantity: 1, unitPrice: 500 },
            { description: "Discount", quantity: 1, unitPrice: -430, isDiscount: true },
          ],
        });
      expect(belowPaid.status).toBe(409);
      expect(JSON.stringify(belowPaid.body)).toContain("already paid");
      expect(JSON.stringify(belowPaid.body)).toContain("refund or apply a credit");
    } finally {
      await db.delete(payments).where(eq(payments.id, paymentId));
    }
  });

  // ── PATCH /api/invoices/:id — mark paid ──────────────────────────────────

  it("PATCH /api/invoices/:id with status 'void' zeroes balanceDue", async () => {
    const { db, invoices: invoicesTable } = dbMod as any;
    const { access } = await makeSession(labOwnerId);

    // Insert an invoice with a non-zero balance so we can confirm it gets cleared.
    const invId = rid("inv");
    await db.insert(invoicesTable).values({
      id: invId,
      invoiceNumber: rid("VOIDINV"),
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      status: "open",
      total: "119.00",
      balanceDue: "119.00",
      createdByUserId: labOwnerId,
    });

    try {
      const r = await request(appMod.default)
        .patch(`/api/invoices/${invId}`)
        .set("Authorization", `Bearer ${access}`)
        .send({ status: "void" });

      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const returned = r.body.data ?? r.body;
      expect(returned.status).toBe("void");
      expect(Number(returned.balanceDue)).toBe(0);

      // Confirm the zero is persisted, not just returned.
      const row = await db.query.invoices.findFirst({
        where: eq(invoicesTable.id, invId),
        columns: { status: true, balanceDue: true },
      });
      expect(row.status).toBe("void");
      expect(Number(row.balanceDue)).toBe(0);
    } finally {
      await db.delete(invoicesTable).where(eq(invoicesTable.id, invId));
    }
  });

  it("DELETE /api/invoices/bulk voids invoices with balanceDue = '0.00'", async () => {
    const { db, invoices: invoicesTable } = dbMod as any;
    const { access } = await makeSession(labOwnerId);

    const invId = rid("inv");
    await db.insert(invoicesTable).values({
      id: invId,
      invoiceNumber: rid("BULKDELINV"),
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      status: "open",
      total: "250.00",
      balanceDue: "250.00",
      createdByUserId: labOwnerId,
    });

    const r = await request(appMod.default)
      .delete("/api/invoices/bulk")
      .set("Authorization", `Bearer ${access}`)
      .send({ labOrganizationId: labOrgId, invoiceIds: [invId] });

    expect(r.status, JSON.stringify(r.body)).toBe(200);

    // The row is soft-deleted but we can still read it by bypassing deletedAt.
    const row = await db.query.invoices.findFirst({
      where: (t: any, { eq: eqFn }: any) => eqFn(t.id, invId),
      columns: { status: true, balanceDue: true, deletedAt: true },
    });
    // Voided by bulk-delete — balance must be zeroed atomically.
    expect(row.status).toBe("void");
    expect(Number(row.balanceDue)).toBe(0);
    // Soft-deleted so it won't appear in normal queries.
    expect(row.deletedAt).toBeTruthy();
  });

  it("PATCH /api/invoices/:id with status 'paid' marks the invoice as paid", async () => {
    const { access } = await makeSession(labOwnerId);
    const invoiceNumber = rid("PAIDINV");

    const create = await request(appMod.default)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${access}`)
      .send({
        invoiceNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
      });
    expect(create.status).toBe(201);
    const invoiceId = create.body.data.id;

    // Move to open first so the status history is realistic
    const toOpen = await request(appMod.default)
      .patch(`/api/invoices/${invoiceId}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ status: "open" });
    expect(toOpen.status).toBe(200);

    const paid = await request(appMod.default)
      .patch(`/api/invoices/${invoiceId}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ status: "paid" });
    expect(paid.status).toBe(200);
    expect(paid.body.data?.status ?? paid.body.status).toBe("paid");
  });

  // ── GET /api/invoices ─────────────────────────────────────────────────────

  it("GET /api/invoices returns list including the created invoice", async () => {
    const { access } = await makeSession(labOwnerId);
    const invoiceNumber = rid("LISTINV");

    const create = await request(appMod.default)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${access}`)
      .send({
        invoiceNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
      });
    expect(create.status).toBe(201);
    const invoiceId = create.body.data.id;

    const list = await request(appMod.default)
      .get(`/api/invoices?labOrganizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${access}`);
    expect(list.status).toBe(200);
    const ids: string[] = (list.body.data ?? []).map((inv: any) => inv.id);
    expect(ids).toContain(invoiceId);
  });

  it("keeps invoice read routes aligned with the lab/provider billing matrix", async () => {
    const fixture = await createInvoiceReadParityFixture();
    const { access } = await makeSession(fixture.mixedIdentityId);

    type InvoiceReadParityRoute = {
      name: string;
      read: (
        accessToken: string,
        routeFixture: InvoiceReadParityFixture,
      ) => Promise<any>;
      expectedStatus: number;
      assertScope: (response: any, routeFixture: InvoiceReadParityFixture) => void;
    };

    const routes: InvoiceReadParityRoute[] = [
      {
        name: "GET /api/invoices",
        expectedStatus: 200,
        read: (accessToken) =>
          request(appMod.default)
            .get("/api/invoices")
            .set("Authorization", `Bearer ${accessToken}`),
        assertScope: (response, routeFixture) => {
          const ids: string[] = (response.body.data ?? []).map(
            (invoice: any) => invoice.id,
          );
          expect(ids).toEqual(
            expect.arrayContaining([
              routeFixture.invoiceIds.lab,
              routeFixture.invoiceIds.allowedProvider,
            ]),
          );
          expect(ids).not.toEqual(
            expect.arrayContaining([
              routeFixture.invoiceIds.deniedProvider,
              routeFixture.invoiceIds.unrelated,
            ]),
          );
        },
      },
      {
        name: "GET /api/invoices/payments-summary allows lab payment history",
        read: (accessToken, routeFixture) =>
          request(appMod.default)
            .get("/api/invoices/payments-summary")
            .query({ labOrganizationId: routeFixture.labOrganizationId })
            .set("Authorization", `Bearer ${accessToken}`),
        expectedStatus: 200,
        assertScope: (response, routeFixture) => {
          const paymentIds: string[] = (response.body.data ?? []).map(
            (payment: any) => payment.id,
          );
          expect(paymentIds).toContain(routeFixture.paymentIds.lab);
          expect(paymentIds).not.toEqual(
            expect.arrayContaining([
              routeFixture.paymentIds.allowedProvider,
              routeFixture.paymentIds.deniedProvider,
              routeFixture.paymentIds.unrelated,
            ]),
          );
        },
      },
      {
        name: "GET /api/invoices/payments/recent allows billing-capable linked provider warnings",
        read: (accessToken, routeFixture) =>
          request(appMod.default)
            .get("/api/invoices/payments/recent")
            .query({
              labOrganizationId: routeFixture.labOrganizationId,
              providerOrganizationId: routeFixture.allowedProviderPracticeId,
            })
            .set("Authorization", `Bearer ${accessToken}`),
        expectedStatus: 200,
        assertScope: (response, routeFixture) => {
          const transactionIds: string[] = (response.body.data ?? []).map(
            (transaction: any) => transaction.id,
          );
          expect(transactionIds).toContain(
            routeFixture.bankTransactionIds.allowedProvider,
          );
          expect(transactionIds).not.toEqual(
            expect.arrayContaining([
              routeFixture.bankTransactionIds.deniedProvider,
            ]),
          );
        },
      },
      {
        name: "GET /api/invoices/payments/recent excludes basic-plan linked provider warnings",
        read: (accessToken, routeFixture) =>
          request(appMod.default)
            .get("/api/invoices/payments/recent")
            .query({
              labOrganizationId: routeFixture.labOrganizationId,
              providerOrganizationId: routeFixture.deniedProviderPracticeId,
            })
            .set("Authorization", `Bearer ${accessToken}`),
        expectedStatus: 200,
        assertScope: (response, routeFixture) => {
          const transactionIds: string[] = (response.body.data ?? []).map(
            (transaction: any) => transaction.id,
          );
          expect(transactionIds).toEqual([]);
        },
      },
      {
        name: "GET /api/invoices/:invoiceId allows lab payment history",
        read: (accessToken, routeFixture) =>
          request(appMod.default)
            .get(`/api/invoices/${routeFixture.invoiceIds.lab}`)
            .set("Authorization", `Bearer ${accessToken}`),
        expectedStatus: 200,
        assertScope: (response, routeFixture) => {
          expect(response.body.data.payments).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ id: routeFixture.paymentIds.lab }),
            ]),
          );
        },
      },
      {
        name: "GET /api/invoices/payments/recent keeps lab payment history in scope",
        read: (accessToken, routeFixture) =>
          request(appMod.default)
            .get("/api/invoices/payments/recent")
            .query({
              labOrganizationId: routeFixture.labOrganizationId,
              providerOrganizationId: routeFixture.ownPracticeId,
              withinDays: 365,
            })
            .set("Authorization", `Bearer ${accessToken}`),
        expectedStatus: 200,
        assertScope: (response, routeFixture) => {
          const transactionIds: string[] = (response.body.data ?? []).map(
            (transaction: any) => transaction.id,
          );
          expect(transactionIds).toContain(routeFixture.recentTransactionIds.lab);
          expect(transactionIds).not.toEqual(
            expect.arrayContaining([
              routeFixture.paymentIds.allowedProvider,
              routeFixture.paymentIds.deniedProvider,
              routeFixture.paymentIds.unrelated,
            ]),
          );
        },
      },
      {
        name: "GET /api/invoices/:invoiceId allows billing-capable provider payment history",
        read: (accessToken, routeFixture) =>
          request(appMod.default)
            .get(`/api/invoices/${routeFixture.invoiceIds.allowedProvider}`)
            .set("Authorization", `Bearer ${accessToken}`),
        expectedStatus: 200,
        assertScope: (response, routeFixture) => {
          expect(response.body.data.payments).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                id: routeFixture.paymentIds.allowedProvider,
              }),
            ]),
          );
        },
      },
      {
        name: "GET /api/invoices/:invoiceId denies basic-plan provider payment history",
        read: (accessToken, routeFixture) =>
          request(appMod.default)
            .get(`/api/invoices/${routeFixture.invoiceIds.deniedProvider}`)
            .set("Authorization", `Bearer ${accessToken}`),
        expectedStatus: 403,
        assertScope: () => {},
      },
      {
        name: "GET /api/invoices/filter-facets",
        expectedStatus: 200,
        read: (accessToken) =>
          request(appMod.default)
            .get("/api/invoices/filter-facets")
            .set("Authorization", `Bearer ${accessToken}`),
        assertScope: (response, routeFixture) => {
          const practiceIds = (response.body.data?.practices ?? []).map(
            (practice: any) => practice.id,
          );
          expect(practiceIds).toEqual(
            expect.arrayContaining([
              routeFixture.ownPracticeId,
              routeFixture.allowedProviderPracticeId,
            ]),
          );
          expect(practiceIds).not.toEqual(
            expect.arrayContaining([
              routeFixture.deniedProviderPracticeId,
              routeFixture.unrelatedPracticeId,
            ]),
          );

          const doctorNames: string[] = response.body.data?.doctors ?? [];
          expect(doctorNames).toEqual(
            expect.arrayContaining([
              "Dr Invoice Parity Lab",
              "Dr Invoice Parity Allowed",
            ]),
          );
          expect(doctorNames).not.toEqual(
            expect.arrayContaining([
              "Dr Invoice Parity Denied",
              "Dr Invoice Parity Unrelated",
            ]),
          );
        },
      },
      {
        name: "GET /api/invoices/practice-summary allows a member lab",
        read: (accessToken, routeFixture) =>
          request(appMod.default)
            .get("/api/invoices/practice-summary")
            .query({
              providerOrganizationId: routeFixture.ownPracticeId,
              labOrganizationId: routeFixture.labOrganizationId,
            })
            .set("Authorization", `Bearer ${accessToken}`),
        expectedStatus: 200,
        assertScope: (response, routeFixture) => {
          const summary = response.body.data;
          expect(summary.providerOrganizationId).toBe(routeFixture.ownPracticeId);
          expect(summary.totals.invoiceCount).toBe(1);
          expect(summary.recentInvoices).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ id: routeFixture.invoiceIds.lab }),
            ]),
          );
        },
      },
      {
        name: "GET /api/invoices/practice-summary allows a billing-capable linked provider",
        read: (accessToken, routeFixture) =>
          request(appMod.default)
            .get("/api/invoices/practice-summary")
            .query({
              providerOrganizationId: routeFixture.allowedProviderPracticeId,
            })
            .set("Authorization", `Bearer ${accessToken}`),
        expectedStatus: 200,
        assertScope: (response, routeFixture) => {
          const summary = response.body.data;
          expect(summary.providerOrganizationId).toBe(
            routeFixture.allowedProviderPracticeId,
          );
          expect(summary.totals.invoiceCount).toBe(1);
          expect(summary.recentInvoices).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                id: routeFixture.invoiceIds.allowedProvider,
              }),
            ]),
          );
        },
      },
      {
        name: "GET /api/invoices/practice-summary keeps denied linked provider private",
        read: (accessToken, routeFixture) =>
          request(appMod.default)
            .get("/api/invoices/practice-summary")
            .query({
              providerOrganizationId: routeFixture.deniedProviderPracticeId,
            })
            .set("Authorization", `Bearer ${accessToken}`),
        expectedStatus: 403,
        assertScope: () => {},
      },
      {
        name: "GET /api/invoices/:invoiceId for a linked billing-capable practice",
        expectedStatus: 200,
        read: (accessToken, routeFixture) =>
          request(appMod.default)
            .get(`/api/invoices/${routeFixture.invoiceIds.allowedProvider}`)
            .set("Authorization", `Bearer ${accessToken}`),
        assertScope: (response, routeFixture) => {
          expect(response.body.data).toEqual(
            expect.objectContaining({ id: routeFixture.invoiceIds.allowedProvider }),
          );
        },
      },
      {
        name: "GET /api/invoices/mobile:<localId> for a linked billing-capable practice",
        expectedStatus: 200,
        read: (accessToken, routeFixture) =>
          request(appMod.default)
            .get(
              `/api/invoices/${encodeURIComponent(
                `mobile:${routeFixture.mobileInvoiceIds.allowedProvider}`,
              )}`,
            )
            .set("Authorization", `Bearer ${accessToken}`),
        assertScope: (response, routeFixture) => {
          expect(response.body.data).toEqual(
            expect.objectContaining({ id: routeFixture.invoiceIds.allowedProvider }),
          );
        },
      },
      {
        name: "GET /api/invoices/:invoiceId for a linked basic-plan practice",
        expectedStatus: 403,
        read: (accessToken, routeFixture) =>
          request(appMod.default)
            .get(`/api/invoices/${routeFixture.invoiceIds.deniedProvider}`)
            .set("Authorization", `Bearer ${accessToken}`),
        assertScope: (response) => {
          expect(response.body.data).toBeUndefined();
        },
      },
      {
        name: "GET /api/invoices/:invoiceId/attachments allows a linked billing-capable practice",
        expectedStatus: 200,
        read: (accessToken, routeFixture) =>
          request(appMod.default)
            .get(
              `/api/invoices/${routeFixture.invoiceIds.allowedProvider}/attachments`,
            )
            .set("Authorization", `Bearer ${accessToken}`),
        assertScope: (response, routeFixture) => {
          expect(response.body.data).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                id: routeFixture.attachmentIds.allowedProvider,
                invoiceId: routeFixture.invoiceIds.allowedProvider,
              }),
            ]),
          );
        },
      },
      {
        name: "GET /api/invoices/:invoiceId/attachments denies a linked basic-plan practice",
        expectedStatus: 403,
        read: (accessToken, routeFixture) =>
          request(appMod.default)
            .get(
              `/api/invoices/${routeFixture.invoiceIds.deniedProvider}/attachments`,
            )
            .set("Authorization", `Bearer ${accessToken}`),
        assertScope: (response) => {
          expect(response.body.data).toBeUndefined();
        },
      },
      {
        name: "GET /api/invoices/mobile:<localId> for a linked basic-plan practice",
        expectedStatus: 403,
        read: (accessToken, routeFixture) =>
          request(appMod.default)
            .get(
              `/api/invoices/${encodeURIComponent(
                `mobile:${routeFixture.mobileInvoiceIds.deniedProvider}`,
              )}`,
            )
            .set("Authorization", `Bearer ${accessToken}`),
        assertScope: (response) => {
          expect(response.body.data).toBeUndefined();
        },
      },
    ];

    try {
      for (const route of routes) {
        const response = await route.read(access, fixture);
        expect(
          response.status,
          `${route.name} response: ${JSON.stringify(response.body)}`,
        ).toBe(route.expectedStatus);
        route.assertScope(response, fixture);
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps direct provider invoice lists and summaries behind billing capability", async () => {
    const fixture = await createInvoiceReadParityFixture();
    const { access: allowedAccess } = await makeSession(
      fixture.directAllowedProviderUserId,
    );
    const { access: deniedAccess } = await makeSession(
      fixture.directDeniedProviderUserId,
    );

    try {
      const allowedList = await request(appMod.default)
        .get("/api/invoices")
        .set("Authorization", `Bearer ${allowedAccess}`);
      expect(allowedList.status, JSON.stringify(allowedList.body)).toBe(200);
      const allowedInvoiceIds: string[] = (allowedList.body.data ?? []).map(
        (invoice: any) => invoice.id,
      );
      expect(allowedInvoiceIds).toEqual(
        expect.arrayContaining([fixture.invoiceIds.allowedProvider]),
      );
      expect(allowedInvoiceIds).not.toEqual(
        expect.arrayContaining([
          fixture.invoiceIds.lab,
          fixture.invoiceIds.deniedProvider,
          fixture.invoiceIds.unrelated,
        ]),
      );

      const allowedSummary = await request(appMod.default)
        .get("/api/invoices/practice-summary")
        .query({
          providerOrganizationId: fixture.allowedProviderPracticeId,
        })
        .set("Authorization", `Bearer ${allowedAccess}`);
      expect(allowedSummary.status, JSON.stringify(allowedSummary.body)).toBe(
        200,
      );
      expect(allowedSummary.body.data).toMatchObject({
        providerOrganizationId: fixture.allowedProviderPracticeId,
        totals: { invoiceCount: 1 },
      });
      expect(allowedSummary.body.data.recentInvoices).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: fixture.invoiceIds.allowedProvider }),
        ]),
      );

      const allowedDetail = await request(appMod.default)
        .get(`/api/invoices/${fixture.invoiceIds.allowedProvider}`)
        .set("Authorization", `Bearer ${allowedAccess}`);
      expect(allowedDetail.status, JSON.stringify(allowedDetail.body)).toBe(200);
      expect(allowedDetail.body.data.payments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: fixture.paymentIds.allowedProvider }),
        ]),
      );

      const allowedFacets = await request(appMod.default)
        .get("/api/invoices/filter-facets")
        .set("Authorization", `Bearer ${allowedAccess}`);
      expect(allowedFacets.status, JSON.stringify(allowedFacets.body)).toBe(200);
      expect(allowedFacets.body.data.practices).toEqual([
        {
          id: fixture.allowedProviderPracticeId,
          name: "Invoice parity allowed practice",
        },
      ]);
      expect(allowedFacets.body.data.doctors).toEqual([
        "Dr Invoice Parity Allowed",
      ]);

      const allowedStatements = await request(appMod.default)
        .get("/api/invoices/practice-statements")
        .query({
          providerOrganizationId: fixture.allowedProviderPracticeId,
          limit: 10,
          offset: 0,
        })
        .set("Authorization", `Bearer ${allowedAccess}`);
      expect(
        allowedStatements.status,
        JSON.stringify(allowedStatements.body),
      ).toBe(200);
      expect(allowedStatements.body.data).toMatchObject({
        rows: [
          expect.objectContaining({
            id: fixture.practiceStatementIds.allowedProvider,
            providerOrganizationId: fixture.allowedProviderPracticeId,
            totalBilled: "25.00",
            totalPaid: "0.00",
            balanceDue: "25.00",
            currentTotalPaid: "0.00",
            currentBalanceDue: "25.00",
          }),
        ],
        total: 1,
      });
      expect(allowedStatements.body.data.rows).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: fixture.practiceStatementIds.deniedProvider,
          }),
          expect.objectContaining({ id: fixture.practiceStatementIds.unrelated }),
        ]),
      );

      const allowedDeniedStatements = await request(appMod.default)
        .get("/api/invoices/practice-statements")
        .query({
          providerOrganizationId: fixture.deniedProviderPracticeId,
        })
        .set("Authorization", `Bearer ${allowedAccess}`);
      expect(
        allowedDeniedStatements.status,
        JSON.stringify(allowedDeniedStatements.body),
      ).toBe(403);

      const deniedList = await request(appMod.default)
        .get("/api/invoices")
        .set("Authorization", `Bearer ${deniedAccess}`);
      expect(deniedList.status, JSON.stringify(deniedList.body)).toBe(403);

      const deniedSummary = await request(appMod.default)
        .get("/api/invoices/practice-summary")
        .query({
          providerOrganizationId: fixture.deniedProviderPracticeId,
        })
        .set("Authorization", `Bearer ${deniedAccess}`);
      expect(deniedSummary.status, JSON.stringify(deniedSummary.body)).toBe(
        403,
      );
      const deniedDetail = await request(appMod.default)
        .get(`/api/invoices/${fixture.invoiceIds.deniedProvider}`)
        .set("Authorization", `Bearer ${deniedAccess}`);
      expect(deniedDetail.status, JSON.stringify(deniedDetail.body)).toBe(403);

      const deniedFacets = await request(appMod.default)
        .get("/api/invoices/filter-facets")
        .set("Authorization", `Bearer ${deniedAccess}`);
      expect(deniedFacets.status, JSON.stringify(deniedFacets.body)).toBe(403);

      const deniedStatements = await request(appMod.default)
        .get("/api/invoices/practice-statements")
        .query({
          providerOrganizationId: fixture.deniedProviderPracticeId,
        })
        .set("Authorization", `Bearer ${deniedAccess}`);
      expect(deniedStatements.status, JSON.stringify(deniedStatements.body)).toBe(
        403,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps invoice payment mutations behind the canonical invoice access matrix", async () => {
    const fixture = await createInvoiceReadParityFixture();
    const { access: allowedAccess } = await makeSession(
      fixture.directAllowedProviderUserId,
    );
    const { access: deniedAccess } = await makeSession(
      fixture.directDeniedProviderUserId,
    );

    try {
      const allowedPost = await request(appMod.default)
        .post(`/api/invoices/${fixture.invoiceIds.allowedProvider}/payments`)
        .set("Authorization", `Bearer ${allowedAccess}`)
        .send({ amount: 1, paymentMethod: "cash" });
      expect(
        allowedPost.status,
        JSON.stringify(allowedPost.body),
      ).toBe(201);
      expect(allowedPost.body.data.payment).toEqual(
        expect.objectContaining({
          invoiceId: fixture.invoiceIds.allowedProvider,
          amount: "1.00",
        }),
      );

      const allowedDelete = await request(appMod.default)
        .delete(`/api/invoices/${fixture.invoiceIds.allowedProvider}/payments`)
        .set("Authorization", `Bearer ${allowedAccess}`);
      expect(
        allowedDelete.status,
        JSON.stringify(allowedDelete.body),
      ).toBe(200);
      expect(allowedDelete.body.data).toEqual(
        expect.objectContaining({ deletedCount: 2 }),
      );

      for (const method of ["post", "delete"] as const) {
        const mutation = request(appMod.default)[method](
          `/api/invoices/${fixture.invoiceIds.deniedProvider}/payments`,
        )
          .set("Authorization", `Bearer ${deniedAccess}`);
        const response =
          method === "post"
            ? await mutation.send({ amount: 1, paymentMethod: "cash" })
            : await mutation;
        expect(
          response.status,
          `${method.toUpperCase()} response: ${JSON.stringify(response.body)}`,
        ).toBe(403);
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it("GET /api/invoices keeps the legacy array response when unpaged", async () => {
    const { db, invoices } = dbMod as any;
    const { access } = await makeSession(labOwnerId);
    const invoiceId = rid("unpaged_invoice");
    const createdAt = new Date("2099-01-01T00:00:00.000Z");

    await db.insert(invoices).values({
      id: invoiceId,
      invoiceNumber: rid("UNPAGED"),
      caseId: null,
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      status: "open",
      createdAt,
      updatedAt: createdAt,
      createdByUserId: labOwnerId,
    });

    try {
      const list = await request(appMod.default)
        .get(
          `/api/invoices?labOrganizationId=${labOrgId}&practiceId=${providerOrgId}` +
            "&dateFrom=2098-12-31T00:00:00.000Z&dateTo=2099-01-02T00:00:00.000Z",
        )
        .set("Authorization", `Bearer ${access}`);

      expect(list.status).toBe(200);
      expect(Array.isArray(list.body.data)).toBe(true);
      expect(list.body.data).toEqual([
        expect.objectContaining({ id: invoiceId }),
      ]);
      expect(list.body.data.rows).toBeUndefined();
    } finally {
      await db.delete(invoices).where(eq(invoices.id, invoiceId));
    }
  });

  it("GET /api/invoices pages newest-first without gaps or duplicates", async () => {
    const { db, invoices } = dbMod as any;
    const { access } = await makeSession(labOwnerId);
    const fixture = Array.from({ length: 5 }, (_, index) => ({
      id: rid("paged_invoice"),
      createdAt: new Date(`2099-02-0${index + 1}T00:00:00.000Z`),
    }));

    await db.insert(invoices).values(
      fixture.map(({ id, createdAt }) => ({
        id,
        invoiceNumber: rid("PAGED"),
        caseId: null,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        status: "open",
        createdAt,
        updatedAt: createdAt,
        createdByUserId: labOwnerId,
      })),
    );

    try {
      const query =
        `/api/invoices?labOrganizationId=${labOrgId}&practiceId=${providerOrgId}` +
        "&dateFrom=2099-01-31T00:00:00.000Z&dateTo=2099-02-06T00:00:00.000Z";
      const first = await request(appMod.default)
        .get(`${query}&limit=2&offset=0`)
        .set("Authorization", `Bearer ${access}`);
      const second = await request(appMod.default)
        .get(`${query}&limit=2&offset=2`)
        .set("Authorization", `Bearer ${access}`);
      const third = await request(appMod.default)
        .get(`${query}&limit=2&offset=4`)
        .set("Authorization", `Bearer ${access}`);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(third.status).toBe(200);
      const expectedIds = fixture
        .slice()
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map(({ id }) => id);
      const firstPage = first.body.data;
      const secondPage = second.body.data;
      const thirdPage = third.body.data;

      expect(firstPage).toMatchObject({
        rows: expectedIds.slice(0, 2).map((id) => expect.objectContaining({ id })),
        total: 5,
        limit: 2,
        offset: 0,
        hasMore: true,
      });
      expect(secondPage).toMatchObject({
        rows: expectedIds.slice(2, 4).map((id) => expect.objectContaining({ id })),
        total: 5,
        limit: 2,
        offset: 2,
        hasMore: true,
      });
      expect(thirdPage).toMatchObject({
        rows: [expect.objectContaining({ id: expectedIds[4] })],
        total: 5,
        limit: 2,
        offset: 4,
        hasMore: false,
      });
      expect([
        ...firstPage.rows,
        ...secondPage.rows,
        ...thirdPage.rows,
      ].map((invoice: any) => invoice.id)).toEqual(expectedIds);
    } finally {
      await db.delete(invoices).where(
        inArray(
          invoices.id,
          fixture.map(({ id }) => id),
        ),
      );
    }
  });

  it("GET /api/invoices applies paging filters to synthesized mobile invoices", async () => {
    const { db, invoices, labCases } = dbMod as any;
    const { access } = await makeSession(labOwnerId);
    const invoiceId = rid("filtered_canonical");
    const mobileCaseId = rid("filtered_mobile_case");
    const localInvoiceId = rid("filtered_mobile_invoice");
    const createdAt = new Date("2099-02-10T00:00:00.000Z");

    await db.insert(invoices).values({
      id: invoiceId,
      invoiceNumber: rid("FILTERED"),
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      status: "open",
      createdAt,
      updatedAt: createdAt,
      createdByUserId: labOwnerId,
    });
    await db.insert(labCases).values({
      id: mobileCaseId,
      organizationId: labOrgId,
      ownerId: labOwnerId,
      caseData: JSON.stringify({
        invoiceId: localInvoiceId,
        caseNumber: rid("MOBILE"),
        invoiceStatus: "open",
        updatedAt: createdAt.getTime(),
      }),
    });

    try {
      const list = await request(appMod.default)
        .get(
          `/api/invoices?labOrganizationId=${labOrgId}&practiceId=${providerOrgId}` +
            "&status=open&dateFrom=2099-02-09T00:00:00.000Z" +
            "&dateTo=2099-02-11T00:00:00.000Z&limit=10&offset=0",
        )
        .set("Authorization", `Bearer ${access}`);

      expect(list.status).toBe(200);
      expect(list.body.data).toMatchObject({
        rows: [expect.objectContaining({ id: invoiceId })],
        total: 1,
        hasMore: false,
      });
    } finally {
      await db.delete(labCases).where(eq(labCases.id, mobileCaseId));
      await db.delete(invoices).where(eq(invoices.id, invoiceId));
    }
  });

  it("GET /api/invoices applies status filtering before paging", async () => {
    const { db, invoices } = dbMod as any;
    const { access } = await makeSession(labOwnerId);
    const fixture = [
      { id: rid("status_open"), status: "open", day: 1 },
      { id: rid("status_paid"), status: "paid", day: 2 },
      { id: rid("status_open"), status: "open", day: 3 },
      { id: rid("status_paid"), status: "paid", day: 4 },
      { id: rid("status_open"), status: "open", day: 5 },
    ].map(({ day, ...row }) => ({
      ...row,
      createdAt: new Date(`2099-03-0${day}T00:00:00.000Z`),
    }));

    await db.insert(invoices).values(
      fixture.map(({ id, status, createdAt }) => ({
        id,
        invoiceNumber: rid("STATUSPAGE"),
        caseId: null,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        status,
        createdAt,
        updatedAt: createdAt,
        createdByUserId: labOwnerId,
      })),
    );

    try {
      const query =
        `/api/invoices?labOrganizationId=${labOrgId}&practiceId=${providerOrgId}` +
        "&status=open&dateFrom=2099-02-28T00:00:00.000Z&dateTo=2099-03-06T00:00:00.000Z";
      const first = await request(appMod.default)
        .get(`${query}&limit=2&offset=0`)
        .set("Authorization", `Bearer ${access}`);
      const second = await request(appMod.default)
        .get(`${query}&limit=2&offset=2`)
        .set("Authorization", `Bearer ${access}`);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const expectedOpenIds = fixture
        .filter(({ status }) => status === "open")
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map(({ id }) => id);
      expect(first.body.data).toMatchObject({
        rows: expectedOpenIds
          .slice(0, 2)
          .map((id) => expect.objectContaining({ id, status: "open" })),
        total: 3,
        limit: 2,
        offset: 0,
        hasMore: true,
      });
      expect(second.body.data).toMatchObject({
        rows: [expect.objectContaining({ id: expectedOpenIds[2], status: "open" })],
        total: 3,
        limit: 2,
        offset: 2,
        hasMore: false,
      });
    } finally {
      await db.delete(invoices).where(
        inArray(
          invoices.id,
          fixture.map(({ id }) => id),
        ),
      );
    }
  });

  it("GET /api/invoices applies search and special statuses before paging", async () => {
    const { db, invoices } = dbMod as any;
    const { access } = await makeSession(labOwnerId);
    const matchingId = rid("search_zero");
    const nonmatchingId = rid("search_other");
    const openZeroId = rid("search_open_zero");
    const createdAt = new Date("2099-03-10T00:00:00.000Z");

    await db.insert(invoices).values([
      {
        id: matchingId,
        invoiceNumber: rid("SEARCHABLE"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        status: "paid",
        balanceDue: "0.00",
        displayMetadataJson: { patientName: "Paging Patient" },
        createdAt,
        updatedAt: createdAt,
        createdByUserId: labOwnerId,
      },
      {
        id: nonmatchingId,
        invoiceNumber: rid("OTHER"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        status: "open",
        balanceDue: "25.00",
        displayMetadataJson: { patientName: "Someone Else" },
        createdAt: new Date("2099-03-11T00:00:00.000Z"),
        updatedAt: createdAt,
        createdByUserId: labOwnerId,
      },
      {
        id: openZeroId,
        invoiceNumber: rid("OPENZERO"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        status: "open",
        balanceDue: "0.00",
        displayMetadataJson: { patientName: "Open Zero Patient", billTo: "Dr Open" },
        createdAt: new Date("2099-03-09T00:00:00.000Z"),
        updatedAt: createdAt,
        createdByUserId: labOwnerId,
      },
    ]);

    try {
      const list = await request(appMod.default)
        .get(
          `/api/invoices?labOrganizationId=${labOrgId}&practiceId=${providerOrgId}` +
            "&status=zero_balance&search=Paging%20Patient" +
            "&dateFrom=2099-03-09T00:00:00.000Z&dateTo=2099-03-12T00:00:00.000Z" +
            "&limit=10&offset=0&includeFacets=true",
        )
        .set("Authorization", `Bearer ${access}`);

      expect(list.status).toBe(200);
      expect(list.body.data).toMatchObject({
        rows: [expect.objectContaining({ id: matchingId })],
        total: 1,
        hasMore: false,
      });
      expect(list.body.data.facets.doctors).toContain("Dr Open");

      const openZero = await request(appMod.default)
        .get(
          `/api/invoices?labOrganizationId=${labOrgId}&practiceId=${providerOrgId}` +
            "&view=open&status=zero_balance&search=Open%20Zero&limit=10&offset=0",
        )
        .set("Authorization", `Bearer ${access}`);
      expect(openZero.status).toBe(200);
      expect(openZero.body.data).toMatchObject({
        rows: [expect.objectContaining({ id: openZeroId, status: "open" })],
        total: 1,
      });
    } finally {
      await db.delete(invoices).where(inArray(invoices.id, [matchingId, nonmatchingId, openZeroId]));
    }
  });

  it("GET /api/invoices/filter-facets returns complete scoped facets without changing list responses", async () => {
    const { db, invoices, labCases, organizations } = dbMod as any;
    const { access } = await makeSession(labOwnerId);
    const secondProviderOrgId = rid("facet_provider");
    const unrelatedLabId = rid("facet_other_lab");
    const unrelatedProviderOrgId = rid("facet_other_provider");
    const canonicalInvoiceId = rid("facet_invoice");
    const secondInvoiceId = rid("facet_invoice");
    const unrelatedInvoiceId = rid("facet_invoice");
    const mobileCaseId = rid("facet_mobile_case");
    const malformedMobileCaseId = rid("facet_malformed_case");
    const deletedMobileCaseId = rid("facet_deleted_case");
    const escapedMobileCaseId = rid("facet_escaped_case");
    const escapedDoctorName = 'Dr "Quoted" Facet';

    await db.insert(organizations).values([
      {
        id: secondProviderOrgId,
        type: "provider",
        name: "Zulu Facet Practice",
        parentLabOrganizationId: labOrgId,
      },
      { id: unrelatedLabId, type: "lab", name: "Unrelated Facet Lab" },
      {
        id: unrelatedProviderOrgId,
        type: "provider",
        name: "Unrelated Facet Practice",
        parentLabOrganizationId: unrelatedLabId,
      },
    ]);
    await db.insert(invoices).values([
      {
        id: canonicalInvoiceId,
        invoiceNumber: rid("FACET"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        status: "open",
        displayMetadataJson: { billTo: "Dr Canonical Facet" },
        createdByUserId: labOwnerId,
      },
      {
        id: secondInvoiceId,
        invoiceNumber: rid("FACET"),
        labOrganizationId: labOrgId,
        providerOrganizationId: secondProviderOrgId,
        status: "paid",
        displayMetadataJson: { doctorName: "Dr Metadata Facet" },
        createdByUserId: labOwnerId,
      },
      {
        id: unrelatedInvoiceId,
        invoiceNumber: rid("FACET"),
        labOrganizationId: unrelatedLabId,
        providerOrganizationId: unrelatedProviderOrgId,
        status: "open",
        displayMetadataJson: { billTo: "Dr Unrelated Facet" },
        createdByUserId: labOwnerId,
      },
    ]);
    await db.insert(labCases).values([
      {
        id: mobileCaseId,
        organizationId: labOrgId,
        ownerId: labOwnerId,
        caseData: JSON.stringify({
          invoiceId: rid("facet_mobile_invoice"),
          doctorName: "Dr Mobile Facet",
        }),
      },
      {
        id: malformedMobileCaseId,
        organizationId: labOrgId,
        ownerId: labOwnerId,
        caseData:
          '{"invoiceId":"phantom","doctorName":"Dr Phantom Facet",malformed',
      },
      {
        id: deletedMobileCaseId,
        organizationId: labOrgId,
        ownerId: labOwnerId,
        deletedAt: new Date(),
        caseData: JSON.stringify({
          invoiceId: rid("facet_deleted_mobile_invoice"),
          doctorName: "Dr Deleted Mobile Facet",
        }),
      },
      {
        id: escapedMobileCaseId,
        organizationId: labOrgId,
        ownerId: labOwnerId,
        caseData: JSON.stringify({
          invoiceId: rid("facet_escaped_mobile_invoice"),
          doctorName: escapedDoctorName,
        }),
      },
    ]);

    try {
      const facets = await request(appMod.default)
        .get(`/api/invoices/filter-facets?labOrganizationId=${labOrgId}`)
        .set("Authorization", `Bearer ${access}`);
      expect(facets.status).toBe(200);
      expect(facets.body.data.practices).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: providerOrgId }),
          { id: secondProviderOrgId, name: "Zulu Facet Practice" },
        ]),
      );
      expect(facets.body.data.doctors).toEqual(
        expect.arrayContaining([
          "Dr Canonical Facet",
          "Dr Metadata Facet",
          "Dr Mobile Facet",
          escapedDoctorName,
        ]),
      );
      expect(facets.body.data.practices).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: unrelatedProviderOrgId })]),
      );
      expect(facets.body.data.doctors).not.toContain("Dr Unrelated Facet");
      expect(facets.body.data.doctors).not.toContain("Dr Deleted Mobile Facet");
      expect(facets.body.data.doctors).not.toContain("Dr Phantom Facet");

      for (const doctorName of [
        "Dr Canonical Facet",
        "Dr Metadata Facet",
        "Dr Mobile Facet",
        escapedDoctorName,
      ]) {
        const filtered = await request(appMod.default)
          .get(
            `/api/invoices?labOrganizationId=${labOrgId}` +
              `&doctorName=${encodeURIComponent(doctorName)}&limit=10&offset=0`,
          )
          .set("Authorization", `Bearer ${access}`);
        expect(filtered.status).toBe(200);
        expect(filtered.body.data.total).toBeGreaterThan(0);
      }

      const practiceFacets = await request(appMod.default)
        .get(`/api/invoices/filter-facets?practiceId=${providerOrgId}`)
        .set("Authorization", `Bearer ${access}`);
      expect(practiceFacets.status).toBe(200);
      expect(practiceFacets.body.data.practices).toEqual([
        expect.objectContaining({ id: providerOrgId }),
      ]);
      expect(practiceFacets.body.data.doctors).toContain("Dr Canonical Facet");
      expect(practiceFacets.body.data.doctors).not.toContain("Dr Mobile Facet");

      const { access: outsiderAccess } = await makeSession(outsiderId);
      const outsiderFacets = await request(appMod.default)
        .get(`/api/invoices/filter-facets?labOrganizationId=${labOrgId}`)
        .set("Authorization", `Bearer ${outsiderAccess}`);
      expect(outsiderFacets.status).toBe(200);
      expect(outsiderFacets.body.data).toEqual({ practices: [], doctors: [] });

      const unpaged = await request(appMod.default)
        .get(`/api/invoices?labOrganizationId=${labOrgId}`)
        .set("Authorization", `Bearer ${access}`);
      const paged = await request(appMod.default)
        .get(`/api/invoices?labOrganizationId=${labOrgId}&limit=1&offset=0`)
        .set("Authorization", `Bearer ${access}`);
      expect(unpaged.status).toBe(200);
      expect(Array.isArray(unpaged.body.data)).toBe(true);
      expect(paged.status).toBe(200);
      expect(paged.body.data).toMatchObject({
        rows: expect.any(Array),
        total: expect.any(Number),
        limit: 1,
        offset: 0,
        hasMore: expect.any(Boolean),
      });
    } finally {
      await db.delete(labCases).where(
        inArray(labCases.id, [
          mobileCaseId,
          malformedMobileCaseId,
          deletedMobileCaseId,
          escapedMobileCaseId,
        ]),
      );
      await db.delete(invoices).where(
        inArray(invoices.id, [canonicalInvoiceId, secondInvoiceId, unrelatedInvoiceId]),
      );
      await db.delete(organizations).where(eq(organizations.id, unrelatedProviderOrgId));
      await db.delete(organizations).where(eq(organizations.id, unrelatedLabId));
      await db.delete(organizations).where(eq(organizations.id, secondProviderOrgId));
    }
  });

  it("GET /api/invoices/filter-facets stays fast with a large scoped invoice history", async () => {
    const { db, invoices, organizations, pool } = dbMod as any;
    const { access } = await makeSession(labOwnerId);
    const scalePracticeAId = rid("facet_scale_practice_a");
    const scalePracticeBId = rid("facet_scale_practice_b");
    const unrelatedLabId = rid("facet_scale_other_lab");
    const unrelatedPracticeId = rid("facet_scale_other_practice");
    const unrelatedInvoiceId = rid("facet_scale_other_invoice");
    const scaleInvoiceIds: string[] = [];
    const practiceADoctors = Array.from(
      { length: 12 },
      (_, index) => `Dr Scale A ${String(index).padStart(2, "0")}`,
    );
    const practiceBDoctors = Array.from(
      { length: 12 },
      (_, index) => `Dr Scale B ${String(index).padStart(2, "0")}`,
    );
    const tailDoctor = "Dr Scale B Tail";
    const largeHistorySize = 1_200;

    await db.insert(organizations).values([
      {
        id: scalePracticeAId,
        type: "provider",
        name: "Scale Facet Practice A",
        parentLabOrganizationId: labOrgId,
      },
      {
        id: scalePracticeBId,
        type: "provider",
        name: "Scale Facet Practice B",
        parentLabOrganizationId: labOrgId,
      },
      { id: unrelatedLabId, type: "lab", name: "Scale Facet Other Lab" },
      {
        id: unrelatedPracticeId,
        type: "provider",
        name: "Scale Facet Other Practice",
        parentLabOrganizationId: unrelatedLabId,
      },
    ]);

    const scaleInvoices = Array.from({ length: largeHistorySize }, (_, index) => {
      const isPracticeA = index < largeHistorySize / 2;
      const doctorNames = isPracticeA ? practiceADoctors : practiceBDoctors;
      const doctorName =
        index === largeHistorySize - 1
          ? tailDoctor
          : doctorNames[index % doctorNames.length];
      const invoiceId = rid("facet_scale_invoice");
      scaleInvoiceIds.push(invoiceId);
      return {
        id: invoiceId,
        invoiceNumber: rid("FACET_SCALE"),
        labOrganizationId: labOrgId,
        providerOrganizationId: isPracticeA ? scalePracticeAId : scalePracticeBId,
        status: "open" as const,
        displayMetadataJson: { billTo: doctorName },
        createdByUserId: labOwnerId,
      };
    });
    await db.insert(invoices).values([
      ...scaleInvoices,
      {
        id: unrelatedInvoiceId,
        invoiceNumber: rid("FACET_SCALE_OTHER"),
        labOrganizationId: unrelatedLabId,
        providerOrganizationId: unrelatedPracticeId,
        status: "open" as const,
        displayMetadataJson: { billTo: "Dr Scale Other Lab" },
        createdByUserId: labOwnerId,
      },
    ]);

    const observedSql: string[] = [];
    const originalPoolQuery = pool.query.bind(pool);
    const querySpy = vi.spyOn(pool, "query").mockImplementation(((config: any, ...args: any[]) => {
      const text = typeof config === "string" ? config : config?.text;
      if (typeof text === "string") observedSql.push(text);
      return originalPoolQuery(config, ...args);
    }) as any);
    const invoiceFindManySpy = vi
      .spyOn(db.query.invoices, "findMany")
      .mockImplementation(() => {
        throw new Error("filter facets must not load invoice response rows");
      });

    try {
      const facets = await request(appMod.default)
        .get(`/api/invoices/filter-facets?labOrganizationId=${labOrgId}`)
        .set("Authorization", `Bearer ${access}`);
      expect(facets.status).toBe(200);
      expect(facets.body.data.practices).toEqual(
        expect.arrayContaining([
          { id: scalePracticeAId, name: "Scale Facet Practice A" },
          { id: scalePracticeBId, name: "Scale Facet Practice B" },
        ]),
      );
      expect(facets.body.data.practices).not.toEqual(
        expect.arrayContaining([{ id: unrelatedPracticeId }]),
      );
      expect(facets.body.data.doctors).toEqual(
        expect.arrayContaining([...practiceADoctors, ...practiceBDoctors, tailDoctor]),
      );
      expect(facets.body.data.doctors).not.toContain("Dr Scale Other Lab");

      const practiceFacets = await request(appMod.default)
        .get(
          `/api/invoices/filter-facets?labOrganizationId=${labOrgId}` +
            `&practiceId=${scalePracticeBId}`,
        )
        .set("Authorization", `Bearer ${access}`);
      expect(practiceFacets.status).toBe(200);
      expect(practiceFacets.body.data.practices).toEqual([
        { id: scalePracticeBId, name: "Scale Facet Practice B" },
      ]);
      expect(practiceFacets.body.data.doctors).toEqual(
        expect.arrayContaining([...practiceBDoctors, tailDoctor]),
      );
      expect(practiceFacets.body.data.doctors).not.toEqual(
        expect.arrayContaining(practiceADoctors),
      );

      const invoiceStatements = observedSql.filter((sqlText) =>
        /\bfrom\s+"?invoices"?\b/i.test(sqlText),
      );
      expect(invoiceStatements.length).toBeGreaterThanOrEqual(2);
      expect(invoiceStatements.every((sqlText) => /\bselect\s+distinct\b/i.test(sqlText))).toBe(
        true,
      );
      for (const tableName of [
        "cases",
        "case_restorations",
        "case_notes",
        "invoice_line_items",
        "bank_transaction_invoices",
      ]) {
        expect(observedSql.join("\n")).not.toMatch(
          new RegExp(`\\b(?:from|join)\\s+"?${tableName}"?\\b`, "i"),
        );
      }
    } finally {
      invoiceFindManySpy.mockRestore();
      querySpy.mockRestore();
      await db.delete(invoices).where(
        inArray(invoices.id, [...scaleInvoiceIds, unrelatedInvoiceId]),
      );
      await db.delete(organizations).where(
        inArray(organizations.id, [
          scalePracticeAId,
          scalePracticeBId,
          unrelatedPracticeId,
          unrelatedLabId,
        ]),
      );
    }
  });

  it("GET /api/invoices/filter-facets scopes large linked-provider facets by capability", async () => {
    const {
      db,
      invoices,
      organizations,
      organizationMemberships,
      doctorAccountLinks,
      subscriptions,
      users,
      userSessions,
    } = dbMod as any;
    const providerUserId = rid("linked_facet_provider_user");
    const linkedAllowedUserIds = [
      rid("linked_facet_allowed_user"),
      rid("linked_facet_allowed_user"),
    ];
    const deniedUserId = rid("linked_facet_denied_user");
    const unrelatedUserId = rid("linked_facet_unrelated_user");
    const primaryLabId = rid("linked_facet_primary_lab");
    const linkedLabIds = [rid("linked_facet_lab"), rid("linked_facet_lab")];
    const deniedLabId = rid("linked_facet_denied_lab");
    const unrelatedLabId = rid("linked_facet_unrelated_lab");
    const practiceIds = [
      rid("linked_facet_primary_practice"),
      rid("linked_facet_allowed_practice"),
      rid("linked_facet_allowed_practice"),
      rid("linked_facet_denied_practice"),
      rid("linked_facet_unrelated_practice"),
    ];
    const [
      primaryPracticeId,
      linkedAllowedPracticeId,
      secondLinkedAllowedPracticeId,
      deniedPracticeId,
      unrelatedPracticeId,
    ] = practiceIds;
    const linkedAllowedDoctorNames = [
      "Dr Linked Facet Primary",
      "Dr Linked Facet Alpha",
      "Dr Linked Facet Beta",
      "Dr Linked Facet Tail",
    ];
    const deniedDoctorName = "Dr Linked Facet Denied";
    const unrelatedDoctorName = "Dr Linked Facet Unrelated";
    const historySize = 900;
    const invoiceIds: string[] = [];
    const deniedInvoiceId = rid("linked_facet_denied_invoice");
    const unrelatedInvoiceId = rid("linked_facet_unrelated_invoice");
    const organizationIds = [
      primaryLabId,
      ...linkedLabIds,
      deniedLabId,
      unrelatedLabId,
      ...practiceIds,
    ];
    const userIds = [
      providerUserId,
      ...linkedAllowedUserIds,
      deniedUserId,
      unrelatedUserId,
    ];

    const linkPair = (left: string, right: string) =>
      left < right
        ? { userIdLow: left, userIdHigh: right }
        : { userIdLow: right, userIdHigh: left };

    await db.insert(users).values([
      {
        id: providerUserId,
        username: `linked_facet_provider_${providerUserId}`,
        password: "x",
        userType: "provider",
      },
      ...linkedAllowedUserIds.map((id) => ({
        id,
        username: `linked_facet_allowed_${id}`,
        password: "x",
        userType: "provider",
      })),
      {
        id: deniedUserId,
        username: `linked_facet_denied_${deniedUserId}`,
        password: "x",
        userType: "provider",
      },
      {
        id: unrelatedUserId,
        username: `linked_facet_unrelated_${unrelatedUserId}`,
        password: "x",
        userType: "provider",
      },
    ]);
    await db.insert(organizations).values([
      { id: primaryLabId, type: "lab", name: "Linked Facet Primary Lab" },
      ...linkedLabIds.map((id, index) => ({
        id,
        type: "lab",
        name: `Linked Facet Lab ${index + 1}`,
      })),
      { id: deniedLabId, type: "lab", name: "Linked Facet Denied Lab" },
      { id: unrelatedLabId, type: "lab", name: "Linked Facet Unrelated Lab" },
      {
        id: primaryPracticeId,
        type: "provider",
        name: "Linked Facet Primary Practice",
        parentLabOrganizationId: primaryLabId,
      },
      {
        id: linkedAllowedPracticeId,
        type: "provider",
        name: "Linked Facet Alpha Practice",
        parentLabOrganizationId: linkedLabIds[0],
      },
      {
        id: secondLinkedAllowedPracticeId,
        type: "provider",
        name: "Linked Facet Beta Practice",
        parentLabOrganizationId: linkedLabIds[1],
      },
      {
        id: deniedPracticeId,
        type: "provider",
        name: "Linked Facet Denied Practice",
        parentLabOrganizationId: deniedLabId,
      },
      {
        id: unrelatedPracticeId,
        type: "provider",
        name: "Linked Facet Unrelated Practice",
        parentLabOrganizationId: unrelatedLabId,
      },
    ]);
    await db.insert(organizationMemberships).values([
      {
        id: rid("linked_facet_membership"),
        labId: primaryPracticeId,
        userId: providerUserId,
        role: "owner",
        status: "active",
        approvedByUserId: providerUserId,
        joinedAt: new Date(),
      },
      {
        id: rid("linked_facet_membership"),
        labId: linkedAllowedPracticeId,
        userId: linkedAllowedUserIds[0],
        role: "owner",
        status: "active",
        approvedByUserId: linkedAllowedUserIds[0],
        joinedAt: new Date(),
      },
      {
        id: rid("linked_facet_membership"),
        labId: secondLinkedAllowedPracticeId,
        userId: linkedAllowedUserIds[1],
        role: "owner",
        status: "active",
        approvedByUserId: linkedAllowedUserIds[1],
        joinedAt: new Date(),
      },
      {
        id: rid("linked_facet_membership"),
        labId: deniedPracticeId,
        userId: deniedUserId,
        role: "owner",
        status: "active",
        approvedByUserId: deniedUserId,
        joinedAt: new Date(),
      },
      {
        id: rid("linked_facet_membership"),
        labId: unrelatedPracticeId,
        userId: unrelatedUserId,
        role: "owner",
        status: "active",
        approvedByUserId: unrelatedUserId,
        joinedAt: new Date(),
      },
    ]);
    await db.insert(doctorAccountLinks).values([
      {
        id: rid("linked_facet_link"),
        ...linkPair(providerUserId, linkedAllowedUserIds[0]),
        linkedVia: "admin_backfill",
      },
      {
        id: rid("linked_facet_link"),
        ...linkPair(providerUserId, linkedAllowedUserIds[1]),
        linkedVia: "admin_backfill",
      },
      {
        id: rid("linked_facet_link"),
        ...linkPair(providerUserId, deniedUserId),
        linkedVia: "admin_backfill",
      },
    ]);
    await db.insert(subscriptions).values([
      ...[
        primaryPracticeId,
        linkedAllowedPracticeId,
        secondLinkedAllowedPracticeId,
      ].map((subjectId) => ({
        id: rid("linked_facet_subscription"),
        subjectType: "provider_org",
        subjectId,
        provider: "test",
        status: "active",
        planType: "provider",
        providerPlan: "standard",
      })),
      {
        id: rid("linked_facet_subscription"),
        subjectType: "provider_org",
        subjectId: deniedPracticeId,
        provider: "test",
        status: "active",
        planType: "provider",
        providerPlan: "basic",
      },
    ]);

    await db.insert(invoices).values(
      Array.from({ length: historySize }, (_, index) => {
        const practiceIndex = index % 3;
        const practiceId = practiceIds[practiceIndex]!;
        const labId =
          practiceIndex === 0
            ? primaryLabId
            : linkedLabIds[practiceIndex - 1]!;
        const doctorName =
          index === historySize - 1
            ? linkedAllowedDoctorNames.at(-1)!
            : linkedAllowedDoctorNames[index % linkedAllowedDoctorNames.length]!;
        const invoiceId = rid("linked_facet_invoice");
        invoiceIds.push(invoiceId);
        return {
          id: invoiceId,
          invoiceNumber: rid("LINKED_FACET"),
          labOrganizationId: labId,
          providerOrganizationId: practiceId,
          status: "open" as const,
          displayMetadataJson: { billTo: doctorName },
          createdByUserId: providerUserId,
        };
      }).concat([
        {
          id: deniedInvoiceId,
          invoiceNumber: rid("LINKED_FACET_DENIED"),
          labOrganizationId: deniedLabId,
          providerOrganizationId: deniedPracticeId,
          status: "open" as const,
          displayMetadataJson: { billTo: deniedDoctorName },
          createdByUserId: deniedUserId,
        },
        {
          id: unrelatedInvoiceId,
          invoiceNumber: rid("LINKED_FACET_UNRELATED"),
          labOrganizationId: unrelatedLabId,
          providerOrganizationId: unrelatedPracticeId,
          status: "open" as const,
          displayMetadataJson: { billTo: unrelatedDoctorName },
          createdByUserId: unrelatedUserId,
        },
      ]),
    );
    invoiceIds.push(deniedInvoiceId, unrelatedInvoiceId);

    try {
      const { access } = await makeSession(providerUserId);
      const allFacets = await request(appMod.default)
        .get("/api/invoices/filter-facets")
        .set("Authorization", `Bearer ${access}`);
      expect(allFacets.status, JSON.stringify(allFacets.body)).toBe(200);
      expect(allFacets.body.data.practices).toEqual(
        expect.arrayContaining([
          { id: primaryPracticeId, name: "Linked Facet Primary Practice" },
          { id: linkedAllowedPracticeId, name: "Linked Facet Alpha Practice" },
          { id: secondLinkedAllowedPracticeId, name: "Linked Facet Beta Practice" },
        ]),
      );
      expect(allFacets.body.data.practices).not.toEqual(
        expect.arrayContaining([
          { id: deniedPracticeId, name: "Linked Facet Denied Practice" },
          { id: unrelatedPracticeId, name: "Linked Facet Unrelated Practice" },
        ]),
      );
      expect(allFacets.body.data.doctors).toEqual(
        expect.arrayContaining(linkedAllowedDoctorNames),
      );
      expect(allFacets.body.data.doctors).not.toEqual(
        expect.arrayContaining([deniedDoctorName, unrelatedDoctorName]),
      );

      for (const excludedLabId of [deniedLabId, unrelatedLabId]) {
        const excludedLabFacets = await request(appMod.default)
          .get(`/api/invoices/filter-facets?labOrganizationId=${excludedLabId}`)
          .set("Authorization", `Bearer ${access}`);
        expect(excludedLabFacets.status).toBe(200);
        expect(excludedLabFacets.body.data).toEqual({ practices: [], doctors: [] });
      }

      const linkedLabFacets = await request(appMod.default)
        .get(`/api/invoices/filter-facets?labOrganizationId=${linkedLabIds[0]}`)
        .set("Authorization", `Bearer ${access}`);
      expect(linkedLabFacets.status).toBe(200);
      expect(linkedLabFacets.body.data.practices).toEqual([
        { id: linkedAllowedPracticeId, name: "Linked Facet Alpha Practice" },
      ]);
      expect(linkedLabFacets.body.data.doctors).toEqual(
        expect.arrayContaining(linkedAllowedDoctorNames),
      );
      expect(linkedLabFacets.body.data.doctors).not.toEqual(
        expect.arrayContaining([deniedDoctorName, unrelatedDoctorName]),
      );
    } finally {
      await db.delete(invoices).where(inArray(invoices.id, invoiceIds));
      await db.delete(subscriptions).where(inArray(subscriptions.subjectId, [
        primaryPracticeId,
        linkedAllowedPracticeId,
        secondLinkedAllowedPracticeId,
        deniedPracticeId,
      ]));
      await db.delete(doctorAccountLinks).where(
        inArray(doctorAccountLinks.userIdLow, userIds),
      );
      await db.delete(doctorAccountLinks).where(
        inArray(doctorAccountLinks.userIdHigh, userIds),
      );
      await db.delete(userSessions).where(inArray(userSessions.userId, userIds));
      await db.delete(organizationMemberships).where(
        inArray(organizationMemberships.userId, userIds),
      );
      await db.delete(organizations).where(inArray(organizations.id, organizationIds));
      await db.delete(users).where(inArray(users.id, userIds));
    }
  });

  it("GET /api/invoices keeps large paged histories bounded and enrichment batched", async () => {
    const { db, cases, invoices, pool } = dbMod as any;
    const { access } = await makeSession(labOwnerId);
    const largeHistorySize = 1_200;
    const staleCaseCount = 120;
    const invoiceIds: string[] = [];
    const caseIds: string[] = [];
    const createdAtBase = Date.parse("2099-05-01T00:00:00.000Z");

    const caseRows = Array.from({ length: staleCaseCount }, (_, index) => {
      const id = rid("invoice_scale_case");
      caseIds.push(id);
      return {
        id,
        caseNumber: rid("INVOICE_SCALE_CASE_NUMBER"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Scale",
        patientLastName: `Patient ${index}`,
        doctorName: "Dr Invoice Scale",
        createdByUserId: labOwnerId,
      };
    });
    const invoiceRows = Array.from({ length: largeHistorySize }, (_, index) => {
      const id = rid("invoice_scale");
      invoiceIds.push(id);
      const caseId = index < staleCaseCount ? caseIds[index] : null;
      return {
        id,
        invoiceNumber: rid("INVOICE_SCALE"),
        caseId,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        status: "open" as const,
        total: "100.00",
        balanceDue: "100.00",
        displayMetadataJson:
          caseId
            ? { patientName: `Scale Patient ${index}` }
            : {
                patientName: `Scale Patient ${index}`,
                billTo: "Dr Invoice Scale",
                caseType: "Crown",
                caseSubtype: "Standard",
                material: "Zirconia",
              },
        createdAt: new Date(createdAtBase + index * 60_000),
        updatedAt: new Date(createdAtBase + index * 60_000),
        createdByUserId: labOwnerId,
      };
    });

    await db.insert(cases).values(caseRows);
    await db.insert(invoices).values(invoiceRows);

    const observedSql: string[] = [];
    const originalPoolQuery = pool.query.bind(pool);
    const querySpy = vi.spyOn(pool, "query").mockImplementation(((config: any, ...args: any[]) => {
      const text = typeof config === "string" ? config : config?.text;
      if (typeof text === "string") observedSql.push(text);
      return originalPoolQuery(config, ...args);
    }) as any);

    const selectStatementsFor = (tableName: string) =>
      observedSql.filter(
        (sqlText) =>
          /\bselect\b/i.test(sqlText) &&
          new RegExp(`\\bfrom\\s+"?${tableName}"?\\b`, "i").test(sqlText),
      );

    try {
      const response = await request(appMod.default)
        .get(
          `/api/invoices?labOrganizationId=${labOrgId}&practiceId=${providerOrgId}` +
            "&dateFrom=2099-05-01T00:00:00.000Z&dateTo=2099-05-02T00:00:00.000Z" +
            "&limit=40&offset=520",
        )
        .set("Authorization", `Bearer ${access}`);

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.data).toMatchObject({
        total: largeHistorySize,
        limit: 40,
        offset: 520,
        hasMore: true,
      });
      expect(response.body.data.rows).toHaveLength(40);
      expect(response.body.data.rows[0].id).toBe(invoiceIds[largeHistorySize - 1 - 520]);
      expect(response.body.data.rows).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: invoiceIds[0] }),
        ]),
      );

      for (const tableName of [
        "cases",
        "case_restorations",
        "case_notes",
        "bank_transaction_invoices",
        "invoice_line_items",
      ]) {
        const statements = selectStatementsFor(tableName);
        expect(
          statements,
          `${tableName} should be loaded with one batched SELECT`,
        ).toHaveLength(1);
        expect(statements[0]).toMatch(/\bin\s*\(/i);
      }

      const staleCaseQuery = selectStatementsFor("cases")[0];
      expect(staleCaseQuery.match(/\$\d+/g)?.length ?? 0).toBeGreaterThan(50);
      expect(selectStatementsFor("invoices")).toHaveLength(1);
    } finally {
      querySpy.mockRestore();
      await db.delete(invoices).where(inArray(invoices.id, invoiceIds));
      await db.delete(cases).where(inArray(cases.id, caseIds));
    }
  });

  it("GET /api/invoices outstanding view excludes invoices due today or later", async () => {
    const { db, invoices } = dbMod as any;
    const { access } = await makeSession(labOwnerId);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const fixture = [
      { id: rid("outstanding_yesterday"), dayOffset: -1 },
      { id: rid("outstanding_today"), dayOffset: 0 },
      { id: rid("outstanding_tomorrow"), dayOffset: 1 },
    ];
    const searchPrefix = rid("OUTSTANDING");

    await db.insert(invoices).values(
      fixture.map(({ id, dayOffset }) => ({
        id,
        invoiceNumber: `${searchPrefix}-${dayOffset}`,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        status: "open",
        balanceDue: "25.00",
        dueAt: new Date(today.getTime() + dayOffset * 86_400_000),
        createdAt: today,
        updatedAt: today,
        createdByUserId: labOwnerId,
      })),
    );

    try {
      const list = await request(appMod.default)
        .get(
          `/api/invoices?labOrganizationId=${labOrgId}&practiceId=${providerOrgId}` +
            `&view=outstanding&search=${encodeURIComponent(searchPrefix)}&limit=10&offset=0`,
        )
        .set("Authorization", `Bearer ${access}`);
      expect(list.status).toBe(200);
      expect(list.body.data).toMatchObject({
        rows: [expect.objectContaining({ id: fixture[0].id })],
        total: 1,
        hasMore: false,
      });
    } finally {
      await db.delete(invoices).where(inArray(invoices.id, fixture.map(({ id }) => id)));
    }
  });

  it("GET /api/invoices/practice-statements pages newest-first", async () => {
    const { db, practiceStatements } = dbMod as any;
    const { access } = await makeSession(labOwnerId);
    const fixture = Array.from({ length: 3 }, (_, index) => ({
      id: rid("paged_statement"),
      createdAt: new Date(`2099-04-0${index + 1}T00:00:00.000Z`),
    }));

    await db.insert(practiceStatements).values(
      fixture.map(({ id, createdAt }) => ({
        id,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        periodStart: new Date("2099-03-01T00:00:00.000Z"),
        periodEnd: new Date("2099-03-31T23:59:59.000Z"),
        invoiceCount: 0,
        totalBilled: "0.00",
        totalPaid: "0.00",
        balanceDue: "0.00",
        invoiceIdsJson: [],
        createdByUserId: labOwnerId,
        createdAt,
      })),
    );

    try {
      const query =
        `/api/invoices/practice-statements?labOrganizationId=${labOrgId}` +
        `&providerOrganizationId=${providerOrgId}`;
      const first = await request(appMod.default)
        .get(`${query}&limit=2&offset=0`)
        .set("Authorization", `Bearer ${access}`);
      const second = await request(appMod.default)
        .get(`${query}&limit=2&offset=2`)
        .set("Authorization", `Bearer ${access}`);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const expectedIds = fixture
        .slice()
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map(({ id }) => id);
      expect(first.body.data).toMatchObject({
        rows: expectedIds
          .slice(0, 2)
          .map((id) => expect.objectContaining({ id })),
        total: 3,
        limit: 2,
        offset: 0,
        hasMore: true,
      });
      expect(second.body.data).toMatchObject({
        rows: [expect.objectContaining({ id: expectedIds[2] })],
        total: 3,
        limit: 2,
        offset: 2,
        hasMore: false,
      });
    } finally {
      await db.delete(practiceStatements).where(
        inArray(
          practiceStatements.id,
          fixture.map(({ id }) => id),
        ),
      );
    }
  });

  // ── GET /api/invoices doctorName filter edge cases ────────────────────────

  it("GET /api/invoices with no doctorName filter returns invoices that have null displayMetadataJson", async () => {
    const { db, invoices } = dbMod as any;
    const { access } = await makeSession(labOwnerId);

    const nullMetaId = rid("inv");
    await db.insert(invoices).values({
      id: nullMetaId,
      invoiceNumber: rid("NULLMETA"),
      caseId: null,
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      status: "open",
      displayMetadataJson: null,
      createdByUserId: labOwnerId,
    });

    try {
      const list = await request(appMod.default)
        .get(`/api/invoices?labOrganizationId=${labOrgId}`)
        .set("Authorization", `Bearer ${access}`);
      expect(list.status).toBe(200);
      const ids: string[] = (list.body.data ?? []).map((inv: any) => inv.id);
      expect(ids).toContain(nullMetaId);
    } finally {
      await db.delete(invoices).where(eq(invoices.id, nullMetaId));
    }
  });

  it("GET /api/invoices with doctorName filter excludes invoices that have null displayMetadataJson", async () => {
    const { db, invoices } = dbMod as any;
    const { access } = await makeSession(labOwnerId);

    const nullMetaId = rid("inv");
    await db.insert(invoices).values({
      id: nullMetaId,
      invoiceNumber: rid("NULLMETA2"),
      caseId: null,
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      status: "open",
      displayMetadataJson: null,
      createdByUserId: labOwnerId,
    });

    try {
      const list = await request(appMod.default)
        .get(`/api/invoices?labOrganizationId=${labOrgId}&doctorName=Dr.+Anyone`)
        .set("Authorization", `Bearer ${access}`);
      expect(list.status).toBe(200);
      const ids: string[] = (list.body.data ?? []).map((inv: any) => inv.id);
      expect(ids).not.toContain(nullMetaId);
    } finally {
      await db.delete(invoices).where(eq(invoices.id, nullMetaId));
    }
  });

  it("GET /api/invoices doctorName filter is case-sensitive (wrong case does not match)", async () => {
    const { db, invoices } = dbMod as any;
    const { access } = await makeSession(labOwnerId);

    const exactName = "Dr. Jordan Reeves";
    const matchId = rid("inv");
    const noMatchId = rid("inv");
    await db.insert(invoices).values([
      {
        id: matchId,
        invoiceNumber: rid("DRCASE1"),
        caseId: null,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        status: "open",
        displayMetadataJson: { billTo: exactName, patientName: "Pat A" },
        createdByUserId: labOwnerId,
      },
      {
        id: noMatchId,
        invoiceNumber: rid("DRCASE2"),
        caseId: null,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        status: "open",
        displayMetadataJson: { billTo: exactName.toLowerCase(), patientName: "Pat B" },
        createdByUserId: labOwnerId,
      },
    ]);

    try {
      const list = await request(appMod.default)
        .get(`/api/invoices?labOrganizationId=${labOrgId}&doctorName=${encodeURIComponent(exactName)}`)
        .set("Authorization", `Bearer ${access}`);
      expect(list.status).toBe(200);
      const ids: string[] = (list.body.data ?? []).map((inv: any) => inv.id);
      expect(ids).toContain(matchId);
      expect(ids).not.toContain(noMatchId);
    } finally {
      await db.delete(invoices).where(eq(invoices.id, matchId));
      await db.delete(invoices).where(eq(invoices.id, noMatchId));
    }
  });

  // ── GET /api/invoices/mobile:<localInvoiceId> (legacy id resolution) ───────

  it("GET /api/invoices/mobile:<localId> resolves to the canonical invoice for that case", async () => {
    const { db, labCases, invoices } = dbMod as any;
    const { access } = await makeSession(labOwnerId);

    const localInvoiceId = `${Date.now()}legacymobileid`;
    const caseNumber = `${Date.now()}`.slice(-6);
    const caseId = rid("case");
    await db.insert(labCases).values({
      id: caseId,
      ownerId: labOwnerId,
      organizationId: labOrgId,
      caseData: JSON.stringify({
        caseNumber,
        invoiceId: localInvoiceId,
        patientName: "Legacy Patient",
        price: 250,
      }),
    });

    // A canonical invoice now exists for that case (e.g. generated on desktop).
    // The generate-invoice path leaves caseId=null for un-promoted mobile cases
    // and links by the `INV-<caseNumber>` invoice number within the lab.
    const canonicalId = rid("inv");
    await db.insert(invoices).values({
      id: canonicalId,
      invoiceNumber: `INV-${caseNumber}`,
      caseId: null,
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      status: "open",
      createdByUserId: labOwnerId,
    });

    const r = await request(appMod.default)
      .get(`/api/invoices/${encodeURIComponent(`mobile:${localInvoiceId}`)}`)
      .set("Authorization", `Bearer ${access}`);

    expect(r.status).toBe(200);
    expect(r.body.data?.id).toBe(canonicalId);
  });

  it("GET /api/invoices/mobile:<localId> returns 403 when caller lacks billing role", async () => {
    const { db, labCases, users: usersTable, organizationMemberships } = dbMod as any;

    // Create a viewer-role member (not in BILLING_ROLES).
    const viewerId = rid("viewer");
    await db.insert(usersTable).values({ id: viewerId, username: `invviewer_${viewerId}`, password: "x" });
    await db.insert(organizationMemberships).values({
      id: rid("m"),
      labId: labOrgId,
      userId: viewerId,
      role: "viewer",
      status: "active",
      approvedByUserId: labOwnerId,
      joinedAt: new Date(),
    });

    const { access } = await makeSession(viewerId);
    const localInvoiceId = `${Date.now()}viewertest`;
    const caseId = rid("case");
    await db.insert(labCases).values({
      id: caseId,
      ownerId: labOwnerId,
      organizationId: labOrgId,
      caseData: JSON.stringify({
        caseNumber: "9999",
        invoiceId: localInvoiceId,
        patientName: "Viewer Patient",
        price: 50,
      }),
    });

    const r = await request(appMod.default)
      .get(`/api/invoices/${encodeURIComponent(`mobile:${localInvoiceId}`)}`)
      .set("Authorization", `Bearer ${access}`);

    expect(r.status).toBe(403);

    // Cleanup viewer
    await db.delete(organizationMemberships).where(eq(organizationMemberships.userId, viewerId));
    await db.delete(usersTable).where(eq(usersTable.id, viewerId));
  });

  it("GET /api/invoices/mobile:<localId> auto-generates canonical invoice when none exists yet", async () => {
    const { db, labCases } = dbMod as any;
    const { access } = await makeSession(labOwnerId);

    const localInvoiceId = `${Date.now()}nocanonicalid`;
    const caseId = rid("case");
    await db.insert(labCases).values({
      id: caseId,
      ownerId: labOwnerId,
      organizationId: labOrgId,
      caseData: JSON.stringify({
        caseNumber: "5678",
        invoiceId: localInvoiceId,
        patientName: "No Canonical Patient",
        caseType: "Crown",
        price: 100,
      }),
    });

    const r = await request(appMod.default)
      .get(`/api/invoices/${encodeURIComponent(`mobile:${localInvoiceId}`)}`)
      .set("Authorization", `Bearer ${access}`);

    // Should auto-generate and return 200 with the new invoice.
    expect(r.status).toBe(200);
    const inv = r.body.data ?? r.body;
    expect(inv.invoiceNumber).toBe("INV-5678");
    expect(inv.labOrganizationId).toBe(labOrgId);
    // Blob price was 100 — should produce one line item and set invoice to open.
    expect(inv.status).toBe("open");
    // The GET endpoint returns nested items in the response body.
    expect(Array.isArray(inv.items)).toBe(true);
    expect(inv.items).toHaveLength(1);
    expect(Number(inv.items[0].unitPrice)).toBeCloseTo(100, 2);

    // Calling again should be idempotent — same invoice returned.
    const r2 = await request(appMod.default)
      .get(`/api/invoices/${encodeURIComponent(`mobile:${localInvoiceId}`)}`)
      .set("Authorization", `Bearer ${access}`);
    expect(r2.status).toBe(200);
    expect((r2.body.data ?? r2.body).id).toBe(inv.id);
  });

  it("GET /api/invoices/mobile:<unknownId> returns 404 when no matching case exists", async () => {
    const { access } = await makeSession(labOwnerId);

    const r = await request(appMod.default)
      .get(`/api/invoices/${encodeURIComponent("mobile:doesnotexist")}`)
      .set("Authorization", `Bearer ${access}`);

    expect(r.status).toBe(404);
  });

  // ── Auto-deposit reversal (paid → open / void) ────────────────────────────

  it("PATCH paid → open voids the auto-deposit", async () => {
    const {
      db,
      bankAccounts: bankAccountsTable,
      bankTransactions: bankTransactionsTable,
      bankTransactionInvoices: bankTransactionInvoicesTable,
      organizations: orgsTable,
    } = dbMod as any;
    const { access } = await makeSession(labOwnerId);

    const acctId = rid("acct");
    await db.insert(bankAccountsTable).values({
      id: acctId,
      labOrganizationId: labOrgId,
      name: "Test Checking",
    });
    await db
      .update(orgsTable)
      .set({ defaultBankAccountId: acctId })
      .where(eq(orgsTable.id, labOrgId));

    try {
      const invoiceNumber = rid("DEPREV");
      const create = await request(appMod.default)
        .post("/api/invoices")
        .set("Authorization", `Bearer ${access}`)
        .send({ invoiceNumber, labOrganizationId: labOrgId, providerOrganizationId: providerOrgId });
      expect(create.status).toBe(201);
      const invoiceId = create.body.data.id;

      await request(appMod.default)
        .patch(`/api/invoices/${invoiceId}`)
        .set("Authorization", `Bearer ${access}`)
        .send({ items: [{ description: "Crown", quantity: 1, unitPrice: 200 }] });

      await request(appMod.default)
        .patch(`/api/invoices/${invoiceId}`)
        .set("Authorization", `Bearer ${access}`)
        .send({ status: "open" });

      const paid = await request(appMod.default)
        .patch(`/api/invoices/${invoiceId}`)
        .set("Authorization", `Bearer ${access}`)
        .send({ status: "paid" });
      expect(paid.status).toBe(200);

      const links = await db
        .select({ txnId: bankTransactionInvoicesTable.bankTransactionId })
        .from(bankTransactionInvoicesTable)
        .where(eq(bankTransactionInvoicesTable.invoiceId, invoiceId));
      expect(links.length).toBeGreaterThan(0);
      const depositId = links[0].txnId;

      const depositAfterPaid = await db.query.bankTransactions.findFirst({
        where: eq(bankTransactionsTable.id, depositId),
      });
      expect(depositAfterPaid?.status).toBe("posted");

      const unpaid = await request(appMod.default)
        .patch(`/api/invoices/${invoiceId}`)
        .set("Authorization", `Bearer ${access}`)
        .send({ status: "open" });
      expect(unpaid.status).toBe(200);
      expect(unpaid.body.data?.status ?? unpaid.body.status).toBe("open");

      const depositAfterUnpaid = await db.query.bankTransactions.findFirst({
        where: eq(bankTransactionsTable.id, depositId),
      });
      expect(depositAfterUnpaid?.status).toBe("void");

      // Invoice link row must be removed so the register has no dangling reference
      const linksAfterUnpaid = await db
        .select({ txnId: bankTransactionInvoicesTable.bankTransactionId })
        .from(bankTransactionInvoicesTable)
        .where(eq(bankTransactionInvoicesTable.invoiceId, invoiceId));
      expect(linksAfterUnpaid.length).toBe(0);
    } finally {
      await db
        .update(orgsTable)
        .set({ defaultBankAccountId: null })
        .where(eq(orgsTable.id, labOrgId));
      await db.delete(bankAccountsTable).where(eq(bankAccountsTable.id, acctId));
    }
  });

  it("PATCH paid → open → paid is idempotent: fresh deposit re-created", async () => {
    const {
      db,
      bankAccounts: bankAccountsTable,
      bankTransactions: bankTransactionsTable,
      bankTransactionInvoices: bankTransactionInvoicesTable,
      organizations: orgsTable,
    } = dbMod as any;
    const { access } = await makeSession(labOwnerId);

    const acctId = rid("acct2");
    await db.insert(bankAccountsTable).values({
      id: acctId,
      labOrganizationId: labOrgId,
      name: "Test Checking 2",
    });
    await db
      .update(orgsTable)
      .set({ defaultBankAccountId: acctId })
      .where(eq(orgsTable.id, labOrgId));

    try {
      const invoiceNumber = rid("IDEM");
      const create = await request(appMod.default)
        .post("/api/invoices")
        .set("Authorization", `Bearer ${access}`)
        .send({ invoiceNumber, labOrganizationId: labOrgId, providerOrganizationId: providerOrgId });
      expect(create.status).toBe(201);
      const invoiceId = create.body.data.id;

      await request(appMod.default)
        .patch(`/api/invoices/${invoiceId}`)
        .set("Authorization", `Bearer ${access}`)
        .send({ items: [{ description: "Bridge", quantity: 1, unitPrice: 300 }] });

      await request(appMod.default)
        .patch(`/api/invoices/${invoiceId}`)
        .set("Authorization", `Bearer ${access}`)
        .send({ status: "open" });

      await request(appMod.default)
        .patch(`/api/invoices/${invoiceId}`)
        .set("Authorization", `Bearer ${access}`)
        .send({ status: "paid" });

      const linksAfterFirstPay = await db
        .select({ txnId: bankTransactionInvoicesTable.bankTransactionId })
        .from(bankTransactionInvoicesTable)
        .where(eq(bankTransactionInvoicesTable.invoiceId, invoiceId));
      const firstDepositId = linksAfterFirstPay[0]?.txnId;
      expect(firstDepositId).toBeTruthy();

      await request(appMod.default)
        .patch(`/api/invoices/${invoiceId}`)
        .set("Authorization", `Bearer ${access}`)
        .send({ status: "open" });

      const repaid = await request(appMod.default)
        .patch(`/api/invoices/${invoiceId}`)
        .set("Authorization", `Bearer ${access}`)
        .send({ status: "paid" });
      expect(repaid.status).toBe(200);
      expect(repaid.body.data?.status ?? repaid.body.status).toBe("paid");

      const linksAfterRepay = await db
        .select({ txnId: bankTransactionInvoicesTable.bankTransactionId })
        .from(bankTransactionInvoicesTable)
        .where(eq(bankTransactionInvoicesTable.invoiceId, invoiceId));

      const activeDeposits = await Promise.all(
        linksAfterRepay.map((l: any) =>
          db.query.bankTransactions.findFirst({
            where: eq(bankTransactionsTable.id, l.txnId),
          })
        )
      );
      const posted = activeDeposits.filter((d: any) => d?.status === "posted");
      expect(posted.length).toBe(1);
    } finally {
      await db
        .update(orgsTable)
        .set({ defaultBankAccountId: null })
        .where(eq(orgsTable.id, labOrgId));
      await db.delete(bankAccountsTable).where(eq(bankAccountsTable.id, acctId));
    }
  });

  // ── issuedAt population on creation ──────────────────────────────────────

  it("POST /api/invoices sets issuedAt on the newly created invoice", async () => {
    const { access } = await makeSession(labOwnerId);
    const invoiceNumber = rid("ISSUED");

    const r = await request(appMod.default)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${access}`)
      .send({
        invoiceNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
      });

    expect(r.status).toBe(201);
    const inv = r.body.data ?? r.body;
    // issuedAt may be returned as a string or date — accept any truthy value.
    expect(inv.issuedAt).toBeTruthy();
  });

  it("POST /api/invoices/cases/:caseId/generate-invoice sets issuedAt on the generated invoice", async () => {
    const { db, cases: casesTable, invoices: invoicesTable } = dbMod as any;
    const { access } = await makeSession(labOwnerId);

    const caseNumber = `26-ISSUED-${randomBytes(4).toString("hex")}`;
    const caseId = rid("case");
    await db.insert(casesTable).values({
      id: caseId,
      caseNumber,
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      patientFirstName: "IssuedAt",
      patientLastName: "Test",
      doctorName: "Dr. Test",
      createdByUserId: labOwnerId,
    });

    try {
      const r = await request(appMod.default)
        .post(`/api/invoices/cases/${caseId}/generate-invoice`)
        .set("Authorization", `Bearer ${access}`);

      expect(r.status).toBe(201);
      const inv = r.body.data ?? r.body;
      expect(inv.issuedAt).toBeTruthy();

      // Also verify via a direct DB read so we confirm it's persisted, not just returned.
      const row = await db.query.invoices.findFirst({
        where: eq(invoicesTable.id, inv.id),
      });
      expect(row?.issuedAt).toBeTruthy();
    } finally {
      await db.delete(invoicesTable).where(eq(invoicesTable.caseId, caseId));
      await db.delete(casesTable).where(eq(casesTable.id, caseId));
    }
  });

  // ── generate-invoice relink guard (cross-patient drift prevention) ─────────
  //
  // Invoice numbers are derived from case numbers ("INV-<caseNumber>") and case
  // numbers are reused across the legacy-mobile and canonical case spaces. When
  // a canonical case's generate-invoice call collides with a pre-existing
  // orphaned (caseId=null) invoice, the endpoint must only adopt it when the
  // patient matches (or is blank) — otherwise it would link a DIFFERENT
  // patient's invoice to this case, showing the wrong "Patient & billing
  // details" against a correct Rx Summary.

  it("generate-invoice ADOPTS + realigns an orphaned (caseId=null) invoice when the patient matches", async () => {
    const { db, cases, invoices } = dbMod as any;
    const { access } = await makeSession(labOwnerId);

    const caseNumber = `26-ADOPT-${randomBytes(4).toString("hex")}`;
    const caseId = rid("case");
    await db.insert(cases).values({
      id: caseId,
      caseNumber,
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      patientFirstName: "Michele",
      patientLastName: "Barber",
      doctorName: "Dr. Synthetic029 Provider029",
      createdByUserId: labOwnerId,
    });

    // Pre-existing orphaned invoice for the SAME patient but with a stale
    // provider + metadata — the legitimate legacy-mobile promotion scenario.
    const orphanId = rid("inv");
    await db.insert(invoices).values({
      id: orphanId,
      invoiceNumber: `INV-${caseNumber}`,
      caseId: null,
      labOrganizationId: labOrgId,
      providerOrganizationId: null,
      status: "open",
      displayMetadataJson: {
        patientName: "Michele Barber",
        billTo: "stale doctor",
        teeth: "#99",
      },
      createdByUserId: labOwnerId,
    });

    try {
      const r = await request(appMod.default)
        .post(`/api/invoices/cases/${caseId}/generate-invoice`)
        .set("Authorization", `Bearer ${access}`);

      // Adopted (not newly created) → 200, same underlying row.
      expect(r.status).toBe(200);
      const inv = r.body.data ?? r.body;
      expect(inv.id).toBe(orphanId);

      const row = await db.query.invoices.findFirst({
        where: eq(invoices.id, orphanId),
      });
      expect(row.caseId).toBe(caseId);
      expect(row.providerOrganizationId).toBe(providerOrgId);
      const meta = row.displayMetadataJson as Record<string, unknown>;
      expect(meta.patientName).toBe("Michele Barber");
      expect(meta.billTo).toBe("Dr. Synthetic029 Provider029");
    } finally {
      await db.delete(invoices).where(eq(invoices.id, orphanId));
      await db.delete(cases).where(eq(cases.id, caseId));
    }
  });

  it("generate-invoice REFUSES (409) to adopt an orphaned invoice belonging to a different patient", async () => {
    const { db, cases, invoices } = dbMod as any;
    const { access } = await makeSession(labOwnerId);

    const caseNumber = `26-COLL-${randomBytes(4).toString("hex")}`;
    const caseId = rid("case");
    await db.insert(cases).values({
      id: caseId,
      caseNumber,
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      patientFirstName: "Michele",
      patientLastName: "Barber",
      doctorName: "Dr. Synthetic029 Provider029",
      createdByUserId: labOwnerId,
    });

    // Pre-existing orphaned invoice that belongs to a DIFFERENT patient and
    // happens to reuse the same case number — the production drift bug.
    const orphanId = rid("inv");
    await db.insert(invoices).values({
      id: orphanId,
      invoiceNumber: `INV-${caseNumber}`,
      caseId: null,
      labOrganizationId: labOrgId,
      providerOrganizationId: null,
      status: "open",
      displayMetadataJson: {
        patientName: "Patient Example",
        billTo: "Dr. Synthetic013 ALIAS013. Provider013",
        teeth: "Upper",
      },
      createdByUserId: labOwnerId,
    });

    try {
      const r = await request(appMod.default)
        .post(`/api/invoices/cases/${caseId}/generate-invoice`)
        .set("Authorization", `Bearer ${access}`);

      expect(r.status).toBe(409);

      // The foreign invoice must be left completely untouched.
      const row = await db.query.invoices.findFirst({
        where: eq(invoices.id, orphanId),
      });
      expect(row.caseId).toBeNull();
      expect(row.providerOrganizationId).toBeNull();
      const meta = row.displayMetadataJson as Record<string, unknown>;
      expect(meta.patientName).toBe("Patient Example");
      expect(meta.billTo).toBe("Dr. Synthetic013 ALIAS013. Provider013");
    } finally {
      await db.delete(invoices).where(eq(invoices.id, orphanId));
      await db.delete(cases).where(eq(cases.id, caseId));
    }
  });

  it("POST /api/invoices/receive-payments persists doctor attribution for duplicate warnings", async () => {
    const { db, invoices, bankAccounts, bankTransactions, bankTransactionInvoices,
      payments, statementPaymentSessions } = dbMod as any;
    const { access } = await makeSession(labOwnerId);
    const accountId = rid("uf");
    const invoiceId = rid("inv");
    await db.insert(bankAccounts).values({
      id: accountId,
      labOrganizationId: labOrgId,
      name: rid("Undeposited"),
      accountType: "undeposited_funds",
      openingBalance: "0.00",
      openingDate: new Date(),
      createdByUserId: labOwnerId,
    });
    await db.insert(invoices).values({
      id: invoiceId,
      invoiceNumber: rid("DOCTORPAY"),
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      status: "open",
      total: "25.00",
      balanceDue: "25.00",
      displayMetadataJson: { billTo: "Dr. Jane Doe" },
      createdByUserId: labOwnerId,
    });

    let transactionId: string | null = null;
    try {
      const receive = await request(appMod.default)
        .post("/api/invoices/receive-payments")
        .set("Authorization", `Bearer ${access}`)
        .send({
          labOrganizationId: labOrgId,
          providerOrganizationId: providerOrgId,
          doctorName: "  Dr.   Jane Doe ",
          paymentMethod: "check",
          applications: [{ invoiceId, amount: 25 }],
        });
      expect(receive.status, JSON.stringify(receive.body)).toBe(201);
      transactionId = receive.body.data.depositTransactionId;

      const session = await db.query.statementPaymentSessions.findFirst({
        where: eq(statementPaymentSessions.bankTransactionId, transactionId),
      });
      expect(session.doctorIdentity).toBe("dr. jane doe");
      expect(session.doctorDisplayName).toBe("Dr.   Jane Doe");

      const recent = await request(appMod.default)
        .get(`/api/invoices/payments/recent?labOrganizationId=${labOrgId}&providerOrganizationId=${providerOrgId}&doctorName=${encodeURIComponent("DR. JANE DOE")}`)
        .set("Authorization", `Bearer ${access}`);
      expect(recent.status).toBe(200);
      expect((recent.body.data ?? []).map((row: any) => row.id)).toContain(transactionId);
    } finally {
      if (transactionId) {
        await cleanupPaymentFixtures(
          { invoiceIds: [invoiceId], transactionIds: [transactionId] },
          db,
        );
        await db.delete(bankTransactionInvoices).where(eq(bankTransactionInvoices.bankTransactionId, transactionId));
        await db.delete(bankTransactions).where(eq(bankTransactions.id, transactionId));
      }
      await db.delete(invoices).where(eq(invoices.id, invoiceId));
      await db.delete(bankAccounts).where(eq(bankAccounts.id, accountId));
    }
  });

  it("GET /api/invoices/payments-summary preserves stable, duplicate-name, and legacy doctor attribution", async () => {
    const { db, doctorProfiles, invoices, payments } = dbMod as any;
    const { access } = await makeSession(labOwnerId);
    const firstProfileId = rid("doctor_profile");
    const secondProfileId = rid("doctor_profile");
    const firstInvoiceId = rid("inv");
    const secondInvoiceId = rid("inv");
    const legacyInvoiceId = rid("inv");
    const firstPaymentId = rid("payment");
    const secondPaymentId = rid("payment");
    const legacyPaymentId = rid("payment");

    await db.insert(doctorProfiles).values([
      {
        id: firstProfileId,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        doctorName: "Dr. Synthetic057",
      },
      {
        id: secondProfileId,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        doctorName: "Dr. Other",
      },
    ]);
    await db.insert(invoices).values([
      {
        id: firstInvoiceId,
        invoiceNumber: rid("SUMMARY"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        doctorIdentity: firstProfileId,
        displayMetadataJson: { billTo: "Dr. Same" },
        createdByUserId: labOwnerId,
      },
      {
        id: secondInvoiceId,
        invoiceNumber: rid("SUMMARY"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        doctorIdentity: secondProfileId,
        displayMetadataJson: { billTo: "Dr. Same" },
        createdByUserId: labOwnerId,
      },
      {
        id: legacyInvoiceId,
        invoiceNumber: rid("SUMMARY"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        doctorIdentity: null,
        displayMetadataJson: { billTo: "Dr. Same" },
        createdByUserId: labOwnerId,
      },
    ]);
    await db.insert(payments).values([
      {
        id: firstPaymentId,
        invoiceId: firstInvoiceId,
        amount: "11.00",
        paymentMethod: "cash",
        recordedByUserId: labOwnerId,
      },
      {
        id: secondPaymentId,
        invoiceId: secondInvoiceId,
        amount: "12.00",
        paymentMethod: "cash",
        recordedByUserId: labOwnerId,
      },
      {
        id: legacyPaymentId,
        invoiceId: legacyInvoiceId,
        amount: "13.00",
        paymentMethod: "cash",
        recordedByUserId: labOwnerId,
      },
    ]);

    try {
      await db
        .update(doctorProfiles)
        .set({ doctorName: "Dr. Renamed" })
        .where(eq(doctorProfiles.id, firstProfileId));

      const response = await request(appMod.default)
        .get(`/api/invoices/payments-summary?labOrganizationId=${labOrgId}`)
        .set("Authorization", `Bearer ${access}`);

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const rowsById = new Map(
        (response.body.data as any[]).map((row: any) => [row.id, row]),
      );
      expect(rowsById.get(firstPaymentId)?.doctorIdentity).toBe(firstProfileId);
      expect(rowsById.get(secondPaymentId)?.doctorIdentity).toBe(secondProfileId);
      expect(rowsById.get(legacyPaymentId)?.doctorIdentity).toBeNull();
      expect(firstProfileId).not.toBe(secondProfileId);
    } finally {
      await cleanupPaymentFixtures(
        {
          invoiceIds: [firstInvoiceId, secondInvoiceId, legacyInvoiceId],
        },
        db,
      );
      await db
        .delete(invoices)
        .where(inArray(invoices.id, [firstInvoiceId, secondInvoiceId, legacyInvoiceId]));
      await db
        .delete(doctorProfiles)
        .where(inArray(doctorProfiles.id, [firstProfileId, secondProfileId]));
    }
  });

});
