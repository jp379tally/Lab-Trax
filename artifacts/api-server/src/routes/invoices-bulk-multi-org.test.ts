/**
 * Integration tests for the bulk invoice DELETE /api/invoices/bulk and
 * POST /api/invoices/bulk-reset endpoints, focused on the multi-org
 * regression.
 *
 * Regression: the desktop Invoices register sent a single
 * `labOrganizationId` (taken from the first invoice in the list) for the
 * whole batch. Both endpoints scoped their match by that one org, so any
 * selected invoice belonging to a different lab org was silently excluded —
 * the server matched zero rows and returned deletedCount/resetCount: 0 with
 * HTTP 200, and the desktop showed "nothing happened".
 *
 * The fix resolves and authorizes each invoice by its OWN labOrganizationId
 * so a selection spanning more than one lab org is fully handled.
 *
 * Skipped when DATABASE_URL is not configured. Each test cleans up after the
 * suite via afterAll so it is safe to run against a shared dev DB.
 *
 * Coverage:
 *  - DELETE /bulk: selection spanning two lab orgs soft-deletes ALL of them
 *  - POST /bulk-reset: selection spanning two lab orgs resets ALL of them
 *  - both: no matching ids → count 0 (HTTP 200)
 *  - both: 403 when the caller lacks a billing role for one touched org
 *  - frozen invoices remain deletable/resettable via the bulk path
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { inArray, eq } from "drizzle-orm";
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
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("Bulk invoice delete/reset across lab orgs (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let auth: typeof import("../lib/auth.js");

  // A user who is a billing member of BOTH labs.
  const billingUserId = rid("ubill");
  // A user who is a billing member of only lab A.
  const labAOnlyUserId = rid("ulaba");

  const labAOrgId = rid("labA");
  const labBOrgId = rid("labB");
  const practiceAId = rid("provA");
  const practiceBId = rid("provB");

  const tokens = { both: "", labAOnly: "" };

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
    labOrganizationId: string;
    providerOrganizationId: string;
    status?: string;
    total?: string;
    balanceDue?: string;
    frozen?: boolean;
  }): Promise<string> {
    const { db, invoices } = dbMod as any;
    const id = rid("inv");
    await db.insert(invoices).values({
      id,
      invoiceNumber: rid("INV"),
      labOrganizationId: opts.labOrganizationId,
      providerOrganizationId: opts.providerOrganizationId,
      status: opts.status ?? "open",
      total: opts.total ?? "100.00",
      balanceDue: opts.balanceDue ?? "100.00",
      frozen: opts.frozen ?? false,
      createdByUserId: billingUserId,
    });
    return id;
  }

  // Insert a legacy mobile-origin case (a lab_cases blob row) carrying an
  // `invoiceId` so it surfaces in GET /api/invoices as `mobile:<invoiceId>`.
  async function insertLegacyMobileCase(opts: {
    organizationId: string;
    localInvoiceId: string;
    caseNumber?: string;
    price?: number;
  }): Promise<string> {
    const { db, labCases } = dbMod as any;
    const id = rid("lc");
    const blob = {
      invoiceId: opts.localInvoiceId,
      caseNumber: opts.caseNumber ?? rid("C"),
      patientName: "Legacy Patient",
      doctorName: "Dr. Legacy",
      price: opts.price ?? 250,
    };
    await db.insert(labCases).values({
      id,
      ownerId: billingUserId,
      organizationId: opts.organizationId,
      caseData: JSON.stringify(blob),
    });
    return id;
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-bulk-multi-org";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    auth = await import("../lib/auth.js");

    const { db, users, organizations, organizationMemberships } = dbMod as any;

    await db.insert(users).values([
      { id: billingUserId, username: `bill_${billingUserId}`, password: "x" },
      { id: labAOnlyUserId, username: `laba_${labAOnlyUserId}`, password: "x" },
    ]);

    await db.insert(organizations).values([
      { id: labAOrgId, type: "lab", name: rid("MultiOrgLabA") },
      { id: labBOrgId, type: "lab", name: rid("MultiOrgLabB") },
      {
        id: practiceAId,
        type: "provider",
        name: rid("MultiOrgPracticeA"),
        parentLabOrganizationId: labAOrgId,
      },
      {
        id: practiceBId,
        type: "provider",
        name: rid("MultiOrgPracticeB"),
        parentLabOrganizationId: labBOrgId,
      },
    ]);

    await db.insert(organizationMemberships).values([
      // billingUser is a billing member of BOTH labs.
      { id: rid("m"), labId: labAOrgId, userId: billingUserId, role: "billing", status: "active" },
      { id: rid("m"), labId: labBOrgId, userId: billingUserId, role: "billing", status: "active" },
      // labAOnlyUser is a billing member of lab A only.
      { id: rid("m"), labId: labAOrgId, userId: labAOnlyUserId, role: "billing", status: "active" },
    ]);

    tokens.both = await makeSession(billingUserId);
    tokens.labAOnly = await makeSession(labAOnlyUserId);
  }, 60_000);

  // Refresh tokens before each test so a concurrent user_sessions wipe does
  // not invalidate shared tokens mid-suite.
  beforeEach(async () => {
    tokens.both = await makeSession(billingUserId);
    tokens.labAOnly = await makeSession(labAOnlyUserId);
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
      auditLogs,
      labCases,
    } = dbMod as any;
    await db
      .delete(auditLogs)
      .where(inArray(auditLogs.organizationId, [labAOrgId, labBOrgId]));
    await db
      .delete(labCases)
      .where(inArray(labCases.organizationId, [labAOrgId, labBOrgId]));
    await db
      .delete(invoices)
      .where(inArray(invoices.labOrganizationId, [labAOrgId, labBOrgId]));
    await db
      .delete(organizationMemberships)
      .where(inArray(organizationMemberships.userId, [billingUserId, labAOnlyUserId]));
    await db
      .delete(userSessions)
      .where(inArray(userSessions.userId, [billingUserId, labAOnlyUserId]));
    await db
      .delete(organizations)
      .where(inArray(organizations.id, [labAOrgId, labBOrgId, practiceAId, practiceBId]));
    await db.delete(users).where(inArray(users.id, [billingUserId, labAOnlyUserId]));
  });

  it("DELETE /bulk soft-deletes a selection spanning two lab orgs", async () => {
    const a1 = await insertInvoice({ labOrganizationId: labAOrgId, providerOrganizationId: practiceAId });
    const a2 = await insertInvoice({ labOrganizationId: labAOrgId, providerOrganizationId: practiceAId });
    const b1 = await insertInvoice({ labOrganizationId: labBOrgId, providerOrganizationId: practiceBId });

    const r = await request(appMod.default)
      .delete("/api/invoices/bulk")
      .set("Authorization", `Bearer ${tokens.both}`)
      // Mirror the desktop bug: send lab A's id as the batch labOrganizationId.
      .send({ labOrganizationId: labAOrgId, invoiceIds: [a1, a2, b1] });

    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.deletedCount).toBe(3);

    const { db, invoices } = dbMod as any;
    const rows = await db.query.invoices.findMany({
      where: inArray(invoices.id, [a1, a2, b1]),
      columns: { id: true, deletedAt: true, status: true },
    });
    for (const row of rows) {
      expect(row.deletedAt).not.toBeNull();
      expect(row.status).toBe("void");
    }
  });

  it("POST /bulk-reset zeros a selection spanning two lab orgs", async () => {
    const a1 = await insertInvoice({ labOrganizationId: labAOrgId, providerOrganizationId: practiceAId, total: "250.00", balanceDue: "250.00" });
    const b1 = await insertInvoice({ labOrganizationId: labBOrgId, providerOrganizationId: practiceBId, total: "75.00", balanceDue: "75.00" });

    const r = await request(appMod.default)
      .post("/api/invoices/bulk-reset")
      .set("Authorization", `Bearer ${tokens.both}`)
      .send({ labOrganizationId: labAOrgId, invoiceIds: [a1, b1] });

    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.resetCount).toBe(2);

    const { db, invoices } = dbMod as any;
    const rows = await db.query.invoices.findMany({
      where: inArray(invoices.id, [a1, b1]),
      columns: { id: true, total: true, balanceDue: true, status: true },
    });
    for (const row of rows) {
      expect(Number(row.total)).toBe(0);
      expect(Number(row.balanceDue)).toBe(0);
      expect(row.status).toBe("draft");
    }
  });

  it("DELETE /bulk returns deletedCount 0 when no ids match", async () => {
    const r = await request(appMod.default)
      .delete("/api/invoices/bulk")
      .set("Authorization", `Bearer ${tokens.both}`)
      .send({ labOrganizationId: labAOrgId, invoiceIds: [rid("missing"), rid("missing")] });

    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.deletedCount).toBe(0);
  });

  it("POST /bulk-reset returns resetCount 0 when no ids match", async () => {
    const r = await request(appMod.default)
      .post("/api/invoices/bulk-reset")
      .set("Authorization", `Bearer ${tokens.both}`)
      .send({ labOrganizationId: labAOrgId, invoiceIds: [rid("missing")] });

    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.resetCount).toBe(0);
  });

  it("DELETE /bulk is 403 (and deletes nothing) when caller lacks billing role for a touched org", async () => {
    const a1 = await insertInvoice({ labOrganizationId: labAOrgId, providerOrganizationId: practiceAId });
    const b1 = await insertInvoice({ labOrganizationId: labBOrgId, providerOrganizationId: practiceBId });

    const r = await request(appMod.default)
      .delete("/api/invoices/bulk")
      .set("Authorization", `Bearer ${tokens.labAOnly}`)
      .send({ labOrganizationId: labAOrgId, invoiceIds: [a1, b1] });

    expect(r.status).toBe(403);

    // Nothing should have been deleted — the request fails closed.
    const { db, invoices } = dbMod as any;
    const rows = await db.query.invoices.findMany({
      where: inArray(invoices.id, [a1, b1]),
      columns: { id: true, deletedAt: true },
    });
    for (const row of rows) {
      expect(row.deletedAt).toBeNull();
    }
  });

  it("DELETE /bulk still deletes frozen (case-deleted) invoices", async () => {
    const frozen = await insertInvoice({ labOrganizationId: labAOrgId, providerOrganizationId: practiceAId, frozen: true });

    const r = await request(appMod.default)
      .delete("/api/invoices/bulk")
      .set("Authorization", `Bearer ${tokens.both}`)
      .send({ labOrganizationId: labAOrgId, invoiceIds: [frozen] });

    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.deletedCount).toBe(1);

    const { db, invoices } = dbMod as any;
    const row = await db.query.invoices.findFirst({
      where: eq(invoices.id, frozen),
      columns: { deletedAt: true },
    });
    expect(row.deletedAt).not.toBeNull();
  });

  it("DELETE /bulk deletes a legacy mobile invoice (mobile:<id>) by stripping the case blob", async () => {
    const localInvoiceId = rid("localInv");
    const lcId = await insertLegacyMobileCase({
      organizationId: labAOrgId,
      localInvoiceId,
    });

    const r = await request(appMod.default)
      .delete("/api/invoices/bulk")
      .set("Authorization", `Bearer ${tokens.both}`)
      .send({
        labOrganizationId: labAOrgId,
        invoiceIds: [`mobile:${localInvoiceId}`],
      });

    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.deletedCount).toBe(1);

    // The synthesized invoice no longer surfaces: the blob's invoiceId is
    // cleared and the prior value is preserved as deletedInvoiceId.
    const { db, labCases } = dbMod as any;
    const row = await db.query.labCases.findFirst({
      where: eq(labCases.id, lcId),
      columns: { caseData: true, deletedAt: true },
    });
    const blob = JSON.parse(row.caseData);
    expect(blob.invoiceId).toBeNull();
    expect(blob.deletedInvoiceId).toBe(localInvoiceId);
    // The underlying case row is kept (not soft-deleted).
    expect(row.deletedAt).toBeNull();
  });

  it("DELETE /bulk deletes a mixed selection of real + legacy mobile invoices", async () => {
    const real = await insertInvoice({ labOrganizationId: labAOrgId, providerOrganizationId: practiceAId });
    const localInvoiceId = rid("localInv");
    const lcId = await insertLegacyMobileCase({
      organizationId: labAOrgId,
      localInvoiceId,
    });

    const r = await request(appMod.default)
      .delete("/api/invoices/bulk")
      .set("Authorization", `Bearer ${tokens.both}`)
      .send({
        labOrganizationId: labAOrgId,
        invoiceIds: [real, `mobile:${localInvoiceId}`],
      });

    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.deletedCount).toBe(2);

    const { db, invoices, labCases } = dbMod as any;
    const realRow = await db.query.invoices.findFirst({
      where: eq(invoices.id, real),
      columns: { deletedAt: true, status: true },
    });
    expect(realRow.deletedAt).not.toBeNull();
    expect(realRow.status).toBe("void");

    const lcRow = await db.query.labCases.findFirst({
      where: eq(labCases.id, lcId),
      columns: { caseData: true },
    });
    expect(JSON.parse(lcRow.caseData).invoiceId).toBeNull();
  });

  it("DELETE /bulk returns 0 for a mobile:<id> with no matching case blob", async () => {
    const r = await request(appMod.default)
      .delete("/api/invoices/bulk")
      .set("Authorization", `Bearer ${tokens.both}`)
      .send({
        labOrganizationId: labAOrgId,
        invoiceIds: [`mobile:${rid("nope")}`],
      });

    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.deletedCount).toBe(0);
  });

  it("DELETE /bulk cannot delete a legacy mobile invoice outside the caller's org scope", async () => {
    const localInvoiceId = rid("localInv");
    const lcId = await insertLegacyMobileCase({
      organizationId: labBOrgId,
      localInvoiceId,
    });

    // labAOnly user has no membership in lab B. The legacy resolver scopes its
    // reads to the caller's own orgs, so the lab B case is invisible: it fails
    // closed as "nothing to delete" (200, deletedCount 0) and the blob is left
    // untouched — no cross-tenant deletion is possible.
    const r = await request(appMod.default)
      .delete("/api/invoices/bulk")
      .set("Authorization", `Bearer ${tokens.labAOnly}`)
      .send({
        labOrganizationId: labAOrgId,
        invoiceIds: [`mobile:${localInvoiceId}`],
      });

    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.deletedCount).toBe(0);

    // The blob is untouched — no partial deletion.
    const { db, labCases } = dbMod as any;
    const row = await db.query.labCases.findFirst({
      where: eq(labCases.id, lcId),
      columns: { caseData: true },
    });
    expect(JSON.parse(row.caseData).invoiceId).toBe(localInvoiceId);
  });

  // ── POST /bulk-reset with legacy mobile invoices ──────────────────────────
  // Regression: bulk-reset passed ids straight to the canonical resolver, so
  // `mobile:<id>` legacy invoices silently resolved to zero rows and kept
  // their balances while the desktop reported a count mismatch.

  it("POST /bulk-reset resets a legacy mobile invoice (mobile:<id>) by zeroing the case blob", async () => {
    const localInvoiceId = rid("localInv");
    const lcId = await insertLegacyMobileCase({
      organizationId: labAOrgId,
      localInvoiceId,
      price: 250,
    });

    const r = await request(appMod.default)
      .post("/api/invoices/bulk-reset")
      .set("Authorization", `Bearer ${tokens.both}`)
      .send({
        labOrganizationId: labAOrgId,
        invoiceIds: [`mobile:${localInvoiceId}`],
      });

    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.resetCount).toBe(1);
    expect(r.body.data.legacyResetCount).toBe(1);
    expect(r.body.data.skippedCount).toBe(0);

    // The blob is zeroed in place: invoiceId kept (still surfaces at $0),
    // status forced to draft, pre-reset price preserved for auditability.
    const { db, labCases, auditLogs } = dbMod as any;
    const row = await db.query.labCases.findFirst({
      where: eq(labCases.id, lcId),
      columns: { caseData: true, deletedAt: true },
    });
    const blob = JSON.parse(row.caseData);
    expect(blob.invoiceId).toBe(localInvoiceId);
    expect(blob.price).toBe(0);
    expect(blob.invoiceStatus).toBe("draft");
    expect(blob.invoiceResetPriorPrice).toBe(250);
    expect(row.deletedAt).toBeNull();

    // The synthesized invoice now reads $0.00 draft in the list.
    const list = await request(appMod.default)
      .get("/api/invoices")
      .set("Authorization", `Bearer ${tokens.both}`);
    expect(list.status).toBe(200);
    const synth = (list.body.data as any[]).find(
      (inv) => inv.id === `mobile:${localInvoiceId}`,
    );
    expect(synth, "synthesized invoice should still surface").toBeTruthy();
    expect(Number(synth.total)).toBe(0);
    expect(Number(synth.balanceDue)).toBe(0);
    expect(synth.status).toBe("draft");

    // An audit row was written for the legacy reset.
    const audits = await db.query.auditLogs.findMany({
      where: eq(auditLogs.entityId, `mobile:${localInvoiceId}`),
    });
    const resetAudit = (audits as any[]).find(
      (a) => a.action === "bulk_invoice_reset",
    );
    expect(resetAudit).toBeTruthy();
    expect(resetAudit.organizationId).toBe(labAOrgId);
    expect(resetAudit.metadataJson?.legacyMobileInvoice).toBe(true);
    expect(resetAudit.metadataJson?.priorPrice).toBe(250);
  });

  it("POST /bulk-reset resets a mixed selection of real + legacy mobile invoices", async () => {
    const real = await insertInvoice({
      labOrganizationId: labAOrgId,
      providerOrganizationId: practiceAId,
      total: "180.00",
      balanceDue: "180.00",
    });
    const localInvoiceId = rid("localInv");
    const lcId = await insertLegacyMobileCase({
      organizationId: labAOrgId,
      localInvoiceId,
      price: 99,
    });

    const r = await request(appMod.default)
      .post("/api/invoices/bulk-reset")
      .set("Authorization", `Bearer ${tokens.both}`)
      .send({
        labOrganizationId: labAOrgId,
        invoiceIds: [real, `mobile:${localInvoiceId}`],
      });

    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.resetCount).toBe(2);
    expect(r.body.data.legacyResetCount).toBe(1);
    expect(r.body.data.skippedCount).toBe(0);

    const { db, invoices, labCases } = dbMod as any;
    const realRow = await db.query.invoices.findFirst({
      where: eq(invoices.id, real),
      columns: { total: true, balanceDue: true, status: true },
    });
    expect(Number(realRow.total)).toBe(0);
    expect(Number(realRow.balanceDue)).toBe(0);
    expect(realRow.status).toBe("draft");

    const lcRow = await db.query.labCases.findFirst({
      where: eq(labCases.id, lcId),
      columns: { caseData: true },
    });
    const blob = JSON.parse(lcRow.caseData);
    expect(blob.price).toBe(0);
    expect(blob.invoiceStatus).toBe("draft");
    expect(blob.invoiceResetPriorPrice).toBe(99);
  });

  it("POST /bulk-reset reports unmatched ids via skippedCount", async () => {
    const real = await insertInvoice({
      labOrganizationId: labAOrgId,
      providerOrganizationId: practiceAId,
    });

    const r = await request(appMod.default)
      .post("/api/invoices/bulk-reset")
      .set("Authorization", `Bearer ${tokens.both}`)
      .send({
        labOrganizationId: labAOrgId,
        invoiceIds: [real, rid("missing"), `mobile:${rid("nope")}`],
      });

    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.resetCount).toBe(1);
    expect(r.body.data.legacyResetCount).toBe(0);
    expect(r.body.data.skippedCount).toBe(2);
  });

  it("POST /bulk-reset with all:true also resets legacy mobile invoices in the lab org", async () => {
    // Use a dedicated fresh lab org so counts are not affected by leftovers
    // from earlier tests in this suite.
    const { db, organizations, organizationMemberships, invoices, labCases, auditLogs } =
      dbMod as any;
    const labCOrgId = rid("labC");
    const practiceCId = rid("provC");
    const membershipId = rid("m");
    await db.insert(organizations).values([
      { id: labCOrgId, type: "lab", name: rid("MultiOrgLabC") },
      {
        id: practiceCId,
        type: "provider",
        name: rid("MultiOrgPracticeC"),
        parentLabOrganizationId: labCOrgId,
      },
    ]);
    await db.insert(organizationMemberships).values({
      id: membershipId,
      labId: labCOrgId,
      userId: billingUserId,
      role: "billing",
      status: "active",
    });

    try {
      const real = await insertInvoice({
        labOrganizationId: labCOrgId,
        providerOrganizationId: practiceCId,
        total: "300.00",
        balanceDue: "300.00",
      });
      const localInvoiceId = rid("localInv");
      const lcId = await insertLegacyMobileCase({
        organizationId: labCOrgId,
        localInvoiceId,
        price: 120,
      });

      const r = await request(appMod.default)
        .post("/api/invoices/bulk-reset")
        .set("Authorization", `Bearer ${tokens.both}`)
        .send({ labOrganizationId: labCOrgId, all: true });

      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.data.resetCount).toBe(2);
      expect(r.body.data.legacyResetCount).toBe(1);

      const realRow = await db.query.invoices.findFirst({
        where: eq(invoices.id, real),
        columns: { total: true, status: true },
      });
      expect(Number(realRow.total)).toBe(0);
      expect(realRow.status).toBe("draft");

      const lcRow = await db.query.labCases.findFirst({
        where: eq(labCases.id, lcId),
        columns: { caseData: true },
      });
      const blob = JSON.parse(lcRow.caseData);
      expect(blob.price).toBe(0);
      expect(blob.invoiceStatus).toBe("draft");
    } finally {
      await db
        .delete(auditLogs)
        .where(eq(auditLogs.organizationId, labCOrgId));
      await db.delete(labCases).where(eq(labCases.organizationId, labCOrgId));
      await db
        .delete(invoices)
        .where(eq(invoices.labOrganizationId, labCOrgId));
      await db
        .delete(organizationMemberships)
        .where(eq(organizationMemberships.id, membershipId));
      await db
        .delete(organizations)
        .where(inArray(organizations.id, [labCOrgId, practiceCId]));
    }
  });

  it("POST /bulk-reset cannot reset a legacy mobile invoice outside the caller's org scope", async () => {
    const localInvoiceId = rid("localInv");
    const lcId = await insertLegacyMobileCase({
      organizationId: labBOrgId,
      localInvoiceId,
      price: 400,
    });

    // labAOnly user has no membership in lab B: the legacy resolver scopes
    // its reads to the caller's own orgs, so the lab B case is invisible and
    // the request fails closed as "nothing to reset".
    const r = await request(appMod.default)
      .post("/api/invoices/bulk-reset")
      .set("Authorization", `Bearer ${tokens.labAOnly}`)
      .send({
        labOrganizationId: labAOrgId,
        invoiceIds: [`mobile:${localInvoiceId}`],
      });

    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.resetCount).toBe(0);

    // The blob is untouched.
    const { db, labCases } = dbMod as any;
    const row = await db.query.labCases.findFirst({
      where: eq(labCases.id, lcId),
      columns: { caseData: true },
    });
    const blob = JSON.parse(row.caseData);
    expect(blob.price).toBe(400);
    expect(blob.invoiceStatus).toBeUndefined();
  });
});
