/**
 * POST /api/admin/cleanup/pre-cutoff-cases — one-shot pre-cutoff data cleanup.
 *
 * Gated by the platform-admin secret (CI path of platformAdminUserOrSecret).
 * Soft-deletes canonical cases (received_at), invoices
 * (COALESCE(issued_at, created_at)), and legacy mobile lab_cases (blob
 * createdAt, epoch-ms) dated strictly before 2026-06-01T04:00:00Z.
 *
 * Coverage:
 *  - 403 without the secret header
 *  - Dry run (default): correct counts, nothing modified
 *  - Live run without confirm phrase → 400, nothing modified
 *  - Live run: pre-cutoff rows soft-deleted, boundary/post rows kept,
 *    unparseable legacy blobs kept (fail-closed), linked post-cutoff invoice
 *    frozen (never deleted), audit entries written
 *  - Idempotency: second live run deletes nothing further
 *
 * Skipped when DATABASE_URL is not set (shared convention).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { inArray } from "drizzle-orm";
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
  caseMediaDir: path.join(require("os").tmpdir(), "labtrax-test-media-pre-cutoff"),
  extractMediaFileName: () => null,
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

const PLATFORM_ADMIN_SECRET = "pre-cutoff-cleanup-test-secret";
process.env["PLATFORM_ADMIN_SECRET"] = PLATFORM_ADMIN_SECRET;

const CUTOFF_MS = Date.parse("2026-06-01T04:00:00.000Z");
const PRE = new Date(CUTOFF_MS - 10 * 24 * 60 * 60 * 1000); // ~May 22
const POST = new Date(CUTOFF_MS + 10 * 24 * 60 * 60 * 1000); // ~Jun 11
const AT_CUTOFF = new Date(CUTOFF_MS); // boundary — must be KEPT (strict <)

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("POST /api/admin/cleanup/pre-cutoff-cases (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };

  const labOrgId = rid("lab");
  const practiceId = rid("prov");
  const userId = rid("uclean");

  const preCaseId = rid("cpre");
  const postCaseId = rid("cpost");
  const boundaryCaseId = rid("cbound");

  const preInvoiceId = rid("invpre");
  const preDraftInvoiceId = rid("invdraft");
  const postInvoiceId = rid("invpost");
  const linkedPostInvoiceId = rid("invlink");

  const preLegacyId = rid("lcpre");
  const postLegacyId = rid("lcpost");
  const badLegacyId = rid("lcbad");

  function adminPost(body: Record<string, unknown>) {
    return request(appMod.default)
      .post("/api/admin/cleanup/pre-cutoff-cases")
      .set("X-Platform-Admin-Secret", PLATFORM_ADMIN_SECRET)
      // Scope every request to this suite's own org so runs against the
      // shared dev DB never touch rows seeded by other suites.
      .send({ organizationId: labOrgId, ...body });
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-pre-cutoff";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");

    const { db, users, organizations, cases, invoices, labCases } = dbMod as any;

    await db.insert(users).values([{ id: userId, username: `u_${userId}`, password: "x" }]);
    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: "Pre-Cutoff Cleanup Lab" },
      {
        id: practiceId,
        type: "provider",
        name: "Pre-Cutoff Practice",
        parentLabOrganizationId: labOrgId,
      },
    ]);

    const caseBase = {
      labOrganizationId: labOrgId,
      providerOrganizationId: practiceId,
      doctorName: "Dr. Cleanup",
      patientFirstName: "Pat",
      patientLastName: "Cleanup",
      status: "received",
      createdByUserId: userId,
    };
    await db.insert(cases).values([
      { id: preCaseId, caseNumber: rid("CN"), ...caseBase, receivedAt: PRE },
      { id: postCaseId, caseNumber: rid("CN"), ...caseBase, receivedAt: POST },
      { id: boundaryCaseId, caseNumber: rid("CN"), ...caseBase, receivedAt: AT_CUTOFF },
    ]);

    const invBase = {
      labOrganizationId: labOrgId,
      providerOrganizationId: practiceId,
      createdByUserId: userId,
      total: "100.00",
      balanceDue: "100.00",
      status: "sent",
    };
    await db.insert(invoices).values([
      // pre-cutoff issued invoice → deleted
      { id: preInvoiceId, invoiceNumber: rid("INV"), ...invBase, issuedAt: PRE },
      // never-issued draft created pre-cutoff → deleted via created_at fallback
      {
        id: preDraftInvoiceId,
        invoiceNumber: rid("INV"),
        ...invBase,
        status: "draft",
        issuedAt: null,
        createdAt: PRE,
      },
      // post-cutoff invoice → kept, untouched
      {
        id: postInvoiceId,
        invoiceNumber: rid("INV"),
        ...invBase,
        issuedAt: POST,
        createdAt: POST,
      },
      // post-cutoff invoice LINKED to a pre-cutoff case → kept but frozen
      {
        id: linkedPostInvoiceId,
        invoiceNumber: rid("INV"),
        ...invBase,
        caseId: preCaseId,
        issuedAt: POST,
        createdAt: POST,
      },
    ]);

    await db.insert(labCases).values([
      {
        id: preLegacyId,
        ownerId: userId,
        organizationId: labOrgId,
        caseData: JSON.stringify({
          caseNumber: "L-PRE",
          patientName: "Legacy Pre",
          createdAt: PRE.getTime(), // epoch-ms, real mobile format
        }),
      },
      {
        id: postLegacyId,
        ownerId: userId,
        organizationId: labOrgId,
        caseData: JSON.stringify({
          caseNumber: "L-POST",
          patientName: "Legacy Post",
          createdAt: POST.getTime(),
        }),
      },
      {
        id: badLegacyId,
        ownerId: userId,
        organizationId: labOrgId,
        // createdAt unparseable → must be KEPT (fail-closed)
        caseData: JSON.stringify({ caseNumber: "L-BAD", createdAt: "not-a-date" }),
      },
    ]);
  });

  afterAll(async () => {
    const { db, users, organizations, cases, invoices, labCases, auditLogs } =
      dbMod as any;
    await db
      .delete(auditLogs)
      .where(
        inArray(auditLogs.entityId, [
          preCaseId,
          postCaseId,
          boundaryCaseId,
          preInvoiceId,
          preDraftInvoiceId,
          postInvoiceId,
          linkedPostInvoiceId,
          preLegacyId,
          postLegacyId,
          badLegacyId,
          "pre-cutoff-cleanup",
        ]),
      );
    await db
      .delete(invoices)
      .where(
        inArray(invoices.id, [
          preInvoiceId,
          preDraftInvoiceId,
          postInvoiceId,
          linkedPostInvoiceId,
        ]),
      );
    await db
      .delete(cases)
      .where(inArray(cases.id, [preCaseId, postCaseId, boundaryCaseId]));
    await db
      .delete(labCases)
      .where(inArray(labCases.id, [preLegacyId, postLegacyId, badLegacyId]));
    await db.delete(organizations).where(inArray(organizations.id, [practiceId, labOrgId]));
    await db.delete(users).where(inArray(users.id, [userId]));
  });

  async function fetchRows() {
    const { db, cases, invoices, labCases } = dbMod as any;
    const caseRows = await db
      .select()
      .from(cases)
      .where(inArray(cases.id, [preCaseId, postCaseId, boundaryCaseId]));
    const invoiceRows = await db
      .select()
      .from(invoices)
      .where(
        inArray(invoices.id, [
          preInvoiceId,
          preDraftInvoiceId,
          postInvoiceId,
          linkedPostInvoiceId,
        ]),
      );
    const legacyRows = await db
      .select()
      .from(labCases)
      .where(inArray(labCases.id, [preLegacyId, postLegacyId, badLegacyId]));
    const byId = (rows: any[]) => Object.fromEntries(rows.map((r) => [r.id, r]));
    return { cases: byId(caseRows), invoices: byId(invoiceRows), legacy: byId(legacyRows) };
  }

  it("rejects requests without the platform-admin secret", async () => {
    const res = await request(appMod.default)
      .post("/api/admin/cleanup/pre-cutoff-cases")
      .send({});
    expect(res.status).toBe(401);
  });

  it("dry run (default) reports counts and modifies nothing", async () => {
    const res = await adminPost({});
    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    // Scoped to this suite's org, so counts are exact.
    expect(res.body.scopeOrganizationId).toBe(labOrgId);
    expect(res.body.canonicalCases).toBe(1);
    expect(res.body.invoices).toBe(2);
    expect(res.body.legacyCases).toBe(1);
    expect(res.body.unparseableLegacySkipped).toBe(1);

    const rows = await fetchRows();
    expect(rows.cases[preCaseId].deletedAt).toBeNull();
    expect(rows.invoices[preInvoiceId].deletedAt).toBeNull();
    expect(rows.legacy[preLegacyId].deletedAt).toBeNull();
    expect(rows.invoices[linkedPostInvoiceId].frozen).toBe(false);
  });

  it("live run without the confirm phrase is rejected and modifies nothing", async () => {
    const res = await adminPost({ dryRun: false });
    expect(res.status).toBe(400);
    const res2 = await adminPost({ dryRun: false, confirm: "WRONG" });
    expect(res2.status).toBe(400);

    const rows = await fetchRows();
    expect(rows.cases[preCaseId].deletedAt).toBeNull();
    expect(rows.legacy[preLegacyId].deletedAt).toBeNull();
  });

  it("live run soft-deletes pre-cutoff rows, keeps boundary/post rows, freezes linked invoices", async () => {
    const res = await adminPost({ dryRun: false, confirm: "DELETE_PRE_JUNE_2026" });
    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(false);

    const rows = await fetchRows();

    // Pre-cutoff canonical case soft-deleted; boundary + post kept.
    expect(rows.cases[preCaseId].deletedAt).not.toBeNull();
    expect(rows.cases[boundaryCaseId].deletedAt).toBeNull();
    expect(rows.cases[postCaseId].deletedAt).toBeNull();

    // Pre-cutoff invoices soft-deleted (issued + created_at draft fallback).
    expect(rows.invoices[preInvoiceId].deletedAt).not.toBeNull();
    expect(rows.invoices[preDraftInvoiceId].deletedAt).not.toBeNull();
    expect(rows.invoices[postInvoiceId].deletedAt).toBeNull();
    expect(rows.invoices[postInvoiceId].frozen).toBe(false);

    // Linked post-cutoff invoice kept but frozen with zeroed balance.
    const linked = rows.invoices[linkedPostInvoiceId];
    expect(linked.deletedAt).toBeNull();
    expect(linked.frozen).toBe(true);
    expect(linked.balanceDue).toBe("0.00");
    expect(linked.caseDeletedAt).not.toBeNull();

    // Legacy: pre deleted, post kept, unparseable kept (fail-closed).
    expect(rows.legacy[preLegacyId].deletedAt).not.toBeNull();
    expect(rows.legacy[preLegacyId].deletedBy).toContain("cleanup:");
    expect(rows.legacy[postLegacyId].deletedAt).toBeNull();
    expect(rows.legacy[badLegacyId].deletedAt).toBeNull();

    // Summary audit entry written.
    const { db, auditLogs } = dbMod as any;
    const audits = await db
      .select()
      .from(auditLogs)
      .where(inArray(auditLogs.entityId, ["pre-cutoff-cleanup"]));
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  it("second live run is idempotent for already-deleted rows", async () => {
    const before = await fetchRows();
    const res = await adminPost({ dryRun: false, confirm: "DELETE_PRE_JUNE_2026" });
    expect(res.status).toBe(200);
    const after = await fetchRows();
    // deletedAt timestamps unchanged (rows not re-deleted).
    expect(String(after.cases[preCaseId].deletedAt)).toBe(String(before.cases[preCaseId].deletedAt));
    expect(String(after.legacy[preLegacyId].deletedAt)).toBe(String(before.legacy[preLegacyId].deletedAt));
    // Kept rows still intact.
    expect(after.cases[postCaseId].deletedAt).toBeNull();
    expect(after.legacy[badLegacyId].deletedAt).toBeNull();
  });
});
