/**
 * Integration tests for invoice routes (regression guard).
 *
 * Skipped when DATABASE_URL is not configured. All inserted rows are removed
 * in afterAll so the suite is safe to run against a shared dev DB.
 *
 * Coverage:
 *  - POST /api/invoices — creates a draft invoice (201)
 *  - GET /api/invoices — returned list includes the created invoice
 *  - POST /api/invoices — 403 when caller is not a lab member
 *  - Unauthenticated requests return 401
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { inArray, eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import request from "supertest";
import * as path from "node:path";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
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

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-invoices";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    authLib = await import("../lib/auth.js");

    const { db, users, organizations, organizationMemberships } = dbMod as any;

    await db.insert(users).values([
      { id: labOwnerId, username: `invowner_${labOwnerId}`, password: "x" },
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

    await db.insert(organizationMemberships).values({
      id: rid("m"),
      labId: labOrgId,
      userId: labOwnerId,
      role: "owner",
      status: "active",
      approvedByUserId: labOwnerId,
      joinedAt: new Date(),
    });
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
      inArray(userSessions.userId, [labOwnerId, outsiderId])
    );
    await db.delete(organizationMemberships).where(
      inArray(organizationMemberships.userId, [labOwnerId, outsiderId])
    );
    await db.delete(organizations).where(eq(organizations.id, providerOrgId));
    await db.delete(organizations).where(eq(organizations.id, labOrgId));
    await db.delete(users).where(inArray(users.id, [labOwnerId, outsiderId]));
  });

  // ── POST /api/invoices ────────────────────────────────────────────────────

  it("POST /api/invoices creates a draft invoice and returns 201", async () => {
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
    expect(r.body.data.status).toBe("draft");
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

  // ── PATCH /api/invoices/:id — mark paid ──────────────────────────────────

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
      doctorName: "Dr. Daniel Sharpstein",
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
      expect(meta.billTo).toBe("Dr. Daniel Sharpstein");
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
      doctorName: "Dr. Daniel Sharpstein",
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
        patientName: "Debra Hudson",
        billTo: "Dr. Brittney K. Craig",
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
      expect(meta.patientName).toBe("Debra Hudson");
      expect(meta.billTo).toBe("Dr. Brittney K. Craig");
    } finally {
      await db.delete(invoices).where(eq(invoices.id, orphanId));
      await db.delete(cases).where(eq(cases.id, caseId));
    }
  });
});
