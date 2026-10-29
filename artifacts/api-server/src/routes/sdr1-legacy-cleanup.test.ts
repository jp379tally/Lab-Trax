/**
 * POST /api/admin/cleanup/sdr1-legacy-open-invoices — one-shot SDR1 cleanup.
 *
 * Gated by the platform-admin secret (CI path of platformAdminUserOrSecret).
 * Soft-deletes still-active legacy lab_cases whose patient name is on the
 * SDR1 target list AND whose blob createdAt falls in the legacy era window
 * (Mar–Jun 2026), plus strictly-linked still-active canonical cases/invoices
 * (number AND name must both match — never number alone).
 *
 * Coverage:
 *  - 401 without the secret header
 *  - 400 without organizationId; 400 for a non-SDR1 org without the test
 *    override flag
 *  - Dry run (default): correct classification, nothing modified
 *  - Live run without confirm phrase → 400, nothing modified
 *  - Live run: matched legacy rows soft-deleted; non-target / ambiguous /
 *    other-org rows kept; linked canonical case+invoice (number+name match)
 *    soft-deleted; canonical number-collision with a different patient KEPT;
 *    audit entry written
 *  - Idempotency: second live run deletes nothing further
 *
 * Skipped when DATABASE_URL is not set (shared convention).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { inArray } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import request from "supertest";
import * as path from "node:path";
import { SDR1_CLEANUP_CONFIRM } from "../lib/sdr1-legacy-cleanup.js";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/sdr1-legacy-cleanup-config.js", () => ({
  legacyCleanupConfigurationAvailable: true,
  legacyCleanupUnavailableMessage: "Synthetic legacy cleanup data unavailable.",
  legacyCleanupConfiguration: {
    labOrganizationId: "00000000-0000-4000-8000-000000000123",
    confirmationPhrase: "CONFIRM_SYNTHETIC_LEGACY_CLEANUP",
    eraStartMs: Date.parse("2026-05-01T00:00:00.000Z"),
    eraEndMs: Date.parse("2026-07-01T00:00:00.000Z"),
    targetPatients: ["Synthetic Patient Alpha", "Synthetic Patient Beta"],
  },
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(require("os").tmpdir(), "labtrax-test-media-synthetic-cleanup"),
  extractMediaFileName: () => null,
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

const PLATFORM_ADMIN_SECRET = "synthetic-cleanup-test-secret";
process.env["PLATFORM_ADMIN_SECRET"] = PLATFORM_ADMIN_SECRET;

const ERA_MS = Date.parse("2026-05-01T00:00:00.000Z"); // inside the window
const PRE_ERA_MS = Date.parse("2025-12-01T00:00:00.000Z"); // outside (before)

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("POST /api/admin/cleanup/sdr1-legacy-open-invoices (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };

  const labOrgId = rid("lab");
  const otherOrgId = rid("olab");
  const practiceId = rid("prov");
  const userId = rid("synthetic-user");

  // Legacy rows use synthetic target names and preserve order/punctuation
  // variants needed to exercise exact-token matching.
  const matchTargetId = rid("lcm1"); // synthetic target, era, has invoiceId → deleted
  const matchVariantId = rid("lcm2"); // punctuation/order variant, era → deleted
  const nonTargetId = rid("lcnt"); // synthetic non-target, era → kept
  const outOfEraId = rid("lcoe"); // target but pre-era → kept (ambiguous)
  const badBlobId = rid("lcbb"); // unparseable blob → kept (ambiguous)
  const otherOrgLegacyId = rid("lcoo"); // target in ANOTHER org → kept

  // Canonical rows in the target org.
  const linkedCaseId = rid("ccl"); // matching number+name → deleted
  const collisionCaseId = rid("ccc"); // same number, different patient → kept
  const linkedInvoiceId = rid("invl"); // linked synthetic invoice → deleted
  const collisionInvoiceId = rid("invc"); // collision invoice → kept
  const unrelatedInvoiceId = rid("invu"); // unrelated synthetic invoice → kept
  const freezeInvoiceId = rid("invf"); // linked to deleted case, but not itself a target

  function adminPost(body: Record<string, unknown>) {
    return request(appMod.default)
      .post("/api/admin/cleanup/sdr1-legacy-open-invoices")
      .set("X-Platform-Admin-Secret", PLATFORM_ADMIN_SECRET)
      .send({
        organizationId: labOrgId,
        allowNonSdr1OrgForTesting: true,
        ...body,
      });
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] = process.env["JWT_SECRET"] ?? "labtrax-test-secret-sdr1";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");

    const { db, users, organizations, cases, invoices, labCases } = dbMod as any;

    await db.insert(users).values([{ id: userId, username: `u_${userId}`, password: "x" }]);
    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: "Synthetic Cleanup Test Lab" },
      { id: otherOrgId, type: "lab", name: "Synthetic Cleanup Other Lab" },
      {
        id: practiceId,
        type: "provider",
        name: "Synthetic Cleanup Practice",
        parentLabOrganizationId: labOrgId,
      },
    ]);

    await db.insert(labCases).values([
      {
        id: matchTargetId,
        ownerId: userId,
        organizationId: labOrgId,
        caseData: JSON.stringify({
          caseNumber: "SYN-CASE-001",
          patientName: "Synthetic Patient Alpha",
          invoiceId: "SYNTHETIC-INVOICE-REFERENCE-001",
          createdAt: ERA_MS,
        }),
      },
      {
        id: matchVariantId,
        ownerId: userId,
        organizationId: labOrgId,
        caseData: JSON.stringify({
          caseNumber: "SYN-CASE-002B",
          patientName: "Beta, Synthetic Patient",
          createdAt: String(ERA_MS), // numeric-string format also seen in prod
        }),
      },
      {
        id: nonTargetId,
        ownerId: userId,
        organizationId: labOrgId,
        caseData: JSON.stringify({
          caseNumber: "SYN-CASE-003",
          patientName: "Synthetic Person Gamma",
          createdAt: ERA_MS,
        }),
      },
      {
        id: outOfEraId,
        ownerId: userId,
        organizationId: labOrgId,
        caseData: JSON.stringify({
          caseNumber: "SYN-CASE-004",
          patientName: "Synthetic Patient Alpha",
          createdAt: PRE_ERA_MS,
        }),
      },
      {
        id: badBlobId,
        ownerId: userId,
        organizationId: labOrgId,
        caseData: "{not-json",
      },
      {
        id: otherOrgLegacyId,
        ownerId: userId,
        organizationId: otherOrgId,
        caseData: JSON.stringify({
          caseNumber: "SYN-CASE-001",
          patientName: "Synthetic Patient Alpha",
          createdAt: ERA_MS,
        }),
      },
    ]);

    const caseBase = {
      labOrganizationId: labOrgId,
      providerOrganizationId: practiceId,
      doctorName: "Dr. Synthetic Provider",
      status: "received",
      createdByUserId: userId,
    };
    await db.insert(cases).values([
      {
        id: linkedCaseId,
        caseNumber: "SYN-CASE-001",
        ...caseBase,
        patientFirstName: "Synthetic",
        patientLastName: "Patient Alpha",
      },
      {
        id: collisionCaseId,
        caseNumber: "SYN-CASE-002B",
        ...caseBase,
        patientFirstName: "Different Synthetic",
        patientLastName: "Patient",
      },
    ]);

    const invBase = {
      labOrganizationId: labOrgId,
      providerOrganizationId: practiceId,
      createdByUserId: userId,
      total: "100.00",
      balanceDue: "100.00",
      status: "open",
    };
    await db.insert(invoices).values([
      {
        id: linkedInvoiceId,
        invoiceNumber: "INV-SYN-CASE-001",
        ...invBase,
        displayMetadataJson: { patientName: "Synthetic Patient Alpha" },
      },
      {
        id: collisionInvoiceId,
        invoiceNumber: "INV-SYN-CASE-002B",
        ...invBase,
        displayMetadataJson: { patientName: "Different Synthetic Patient" },
      },
      {
        id: unrelatedInvoiceId,
        invoiceNumber: "INV-SYN-CASE-099",
        ...invBase,
        displayMetadataJson: { patientName: "Synthetic Patient Alpha" },
      },
      {
        id: freezeInvoiceId,
        invoiceNumber: rid("INV-FREEZE"),
        ...invBase,
        caseId: linkedCaseId,
        displayMetadataJson: { patientName: "Unrelated Synthetic Patient" },
      },
    ]);
  });

  afterAll(async () => {
    const { db, users, organizations, cases, invoices, labCases, auditLogs } = dbMod as any;
    await db
      .delete(auditLogs)
      .where(
        inArray(auditLogs.entityId, [
          matchTargetId,
          matchVariantId,
          nonTargetId,
          outOfEraId,
          badBlobId,
          otherOrgLegacyId,
          linkedCaseId,
          collisionCaseId,
          linkedInvoiceId,
          collisionInvoiceId,
          unrelatedInvoiceId,
          freezeInvoiceId,
          "sdr1-legacy-cleanup",
        ]),
      );
    await db
      .delete(invoices)
      .where(
        inArray(invoices.id, [
          linkedInvoiceId,
          collisionInvoiceId,
          unrelatedInvoiceId,
          freezeInvoiceId,
        ]),
      );
    await db.delete(cases).where(inArray(cases.id, [linkedCaseId, collisionCaseId]));
    await db
      .delete(labCases)
      .where(
        inArray(labCases.id, [
          matchTargetId,
          matchVariantId,
          nonTargetId,
          outOfEraId,
          badBlobId,
          otherOrgLegacyId,
        ]),
      );
    await db
      .delete(organizations)
      .where(inArray(organizations.id, [practiceId, labOrgId, otherOrgId]));
    await db.delete(users).where(inArray(users.id, [userId]));
  });

  async function fetchRows() {
    const { db, cases, invoices, labCases } = dbMod as any;
    const legacyRows = await db
      .select()
      .from(labCases)
      .where(
        inArray(labCases.id, [
          matchTargetId,
          matchVariantId,
          nonTargetId,
          outOfEraId,
          badBlobId,
          otherOrgLegacyId,
        ]),
      );
    const caseRows = await db
      .select()
      .from(cases)
      .where(inArray(cases.id, [linkedCaseId, collisionCaseId]));
    const invoiceRows = await db
      .select()
      .from(invoices)
      .where(
        inArray(invoices.id, [
          linkedInvoiceId,
          collisionInvoiceId,
          unrelatedInvoiceId,
          freezeInvoiceId,
        ]),
      );
    const byId = (rows: any[]) => Object.fromEntries(rows.map((r) => [r.id, r]));
    return { legacy: byId(legacyRows), cases: byId(caseRows), invoices: byId(invoiceRows) };
  }

  it("rejects requests without the platform-admin secret", async () => {
    const res = await request(appMod.default)
      .post("/api/admin/cleanup/sdr1-legacy-open-invoices")
      .send({ organizationId: labOrgId });
    expect(res.status).toBe(401);
  });

  it("requires organizationId", async () => {
    const res = await request(appMod.default)
      .post("/api/admin/cleanup/sdr1-legacy-open-invoices")
      .set("X-Platform-Admin-Secret", PLATFORM_ADMIN_SECRET)
      // sweep-scope-lint:allow the missing scope IS the assertion — the route
      // answers 400 before it reads a row, so nothing can be swept.
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/organizationId/i);
  });

  it("rejects a non-SDR1 org without the test override flag", async () => {
    const res = await request(appMod.default)
      .post("/api/admin/cleanup/sdr1-legacy-open-invoices")
      .set("X-Platform-Admin-Secret", PLATFORM_ADMIN_SECRET)
      .send({ organizationId: labOrgId });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/SDR1/i);
  });

  it("dry run (default) classifies rows and modifies nothing", async () => {
    const res = await adminPost({});
    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.scopeOrganizationId).toBe(labOrgId);

    // Only this suite's org rows are in scope (5 of the 6 seeded legacy rows).
    expect(res.body.activeLegacyRows).toBe(5);
    expect(res.body.matched).toBe(2); // both synthetic targets
    expect(res.body.nonTargetSkipped).toBe(1); // synthetic non-target
    expect(res.body.ambiguousSkipped).toBe(2); // out-of-era target + bad blob

    const matchedIds = res.body.matchedRows.map((r: any) => r.id).sort();
    expect(matchedIds).toEqual([matchTargetId, matchVariantId].sort());

    // Canonical linkage: number+name matches deleted-set; collision skipped.
    expect(res.body.linkedCanonicalCaseRows.map((r: any) => r.id)).toEqual([linkedCaseId]);
    expect(res.body.skippedCanonicalCaseCollisionRows.map((r: any) => r.id)).toEqual([
      collisionCaseId,
    ]);
    expect(res.body.linkedCanonicalInvoiceRows.map((r: any) => r.id)).toEqual([
      linkedInvoiceId,
    ]);
    expect(res.body.skippedCanonicalInvoiceCollisionRows.map((r: any) => r.id)).toEqual([
      collisionInvoiceId,
    ]);

    // Nothing modified.
    const rows = await fetchRows();
    for (const r of Object.values<any>(rows.legacy)) expect(r.deletedAt).toBeNull();
    for (const r of Object.values<any>(rows.cases)) expect(r.deletedAt).toBeNull();
    for (const r of Object.values<any>(rows.invoices)) expect(r.deletedAt).toBeNull();
  });

  it("live run without the confirm phrase is rejected and modifies nothing", async () => {
    const res = await adminPost({ dryRun: false });
    expect(res.status).toBe(400);
    const res2 = await adminPost({ dryRun: false, confirm: "WRONG" });
    expect(res2.status).toBe(400);

    const rows = await fetchRows();
    expect(rows.legacy[matchTargetId].deletedAt).toBeNull();
    expect(rows.cases[linkedCaseId].deletedAt).toBeNull();
  });

  it("rolls back the cleanup match set when a linked invoice freeze audit fails", async () => {
    const { pool } = dbMod as any;
    const triggerName = `fail_sdr1_freeze_${randomBytes(8).toString("hex")}`;
    const functionName = `${triggerName}_fn`;

    try {
      await pool.query(`
        CREATE FUNCTION ${functionName}() RETURNS trigger AS $$
        BEGIN
          IF NEW.action = 'invoice_frozen_case_deleted'
             AND NEW.entity_id = '${freezeInvoiceId}' THEN
            RAISE EXCEPTION 'injected SDR1 freeze audit failure';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER ${triggerName}
          BEFORE INSERT ON audit_logs
          FOR EACH ROW EXECUTE FUNCTION ${functionName}();
      `);

      const res = await adminPost({ dryRun: false, confirm: SDR1_CLEANUP_CONFIRM });
      expect(res.status).toBe(500);

      const rows = await fetchRows();
      expect(rows.legacy[matchTargetId].deletedAt).toBeNull();
      expect(rows.cases[linkedCaseId].deletedAt).toBeNull();
      expect(rows.invoices[linkedInvoiceId].deletedAt).toBeNull();
      expect(rows.invoices[freezeInvoiceId].frozen).toBe(false);
      expect(Number(rows.invoices[freezeInvoiceId].balanceDue)).toBe(100);
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON audit_logs`);
      await pool.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
    }
  });

  it("live run soft-deletes matched + strictly-linked rows only", async () => {
    const res = await adminPost({ dryRun: false, confirm: SDR1_CLEANUP_CONFIRM });
    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(false);
    expect(res.body.legacyDeleted).toBe(2);
    expect(res.body.canonicalCasesDeleted).toBe(1);
    expect(res.body.canonicalInvoicesDeleted).toBe(1);

    const rows = await fetchRows();

    // Matched legacy rows soft-deleted with the cleanup marker.
    expect(rows.legacy[matchTargetId].deletedAt).not.toBeNull();
    expect(rows.legacy[matchTargetId].deletedBy).toContain("cleanup:sdr1-legacy:");
    expect(rows.legacy[matchVariantId].deletedAt).not.toBeNull();

    // Kept: non-target, out-of-era, unparseable, other-org.
    expect(rows.legacy[nonTargetId].deletedAt).toBeNull();
    expect(rows.legacy[outOfEraId].deletedAt).toBeNull();
    expect(rows.legacy[badBlobId].deletedAt).toBeNull();
    expect(rows.legacy[otherOrgLegacyId].deletedAt).toBeNull();

    // Canonical: linked (number+name) deleted; collision kept.
    expect(rows.cases[linkedCaseId].deletedAt).not.toBeNull();
    expect(rows.cases[collisionCaseId].deletedAt).toBeNull();
    expect(rows.invoices[linkedInvoiceId].deletedAt).not.toBeNull();
    expect(rows.invoices[collisionInvoiceId].deletedAt).toBeNull();
    expect(rows.invoices[unrelatedInvoiceId].deletedAt).toBeNull();
    expect(rows.invoices[freezeInvoiceId].deletedAt).toBeNull();
    expect(rows.invoices[freezeInvoiceId].frozen).toBe(true);
    expect(Number(rows.invoices[freezeInvoiceId].balanceDue)).toBe(0);

    // Summary audit entry written.
    const { db, auditLogs } = dbMod as any;
    const audits = await db
      .select()
      .from(auditLogs)
      .where(inArray(auditLogs.entityId, ["sdr1-legacy-cleanup"]));
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  it("second live run is idempotent", async () => {
    const before = await fetchRows();
    const res = await adminPost({ dryRun: false, confirm: SDR1_CLEANUP_CONFIRM });
    expect(res.status).toBe(200);
    expect(res.body.legacyDeleted).toBe(0);
    expect(res.body.canonicalCasesDeleted).toBe(0);
    expect(res.body.canonicalInvoicesDeleted).toBe(0);

    const after = await fetchRows();
    expect(String(after.legacy[matchTargetId].deletedAt)).toBe(
      String(before.legacy[matchTargetId].deletedAt),
    );
    expect(after.legacy[nonTargetId].deletedAt).toBeNull();
    expect(after.legacy[otherOrgLegacyId].deletedAt).toBeNull();
  });
});
