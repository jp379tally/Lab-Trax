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

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(require("os").tmpdir(), "labtrax-test-media-sdr1-cleanup"),
  extractMediaFileName: () => null,
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

const PLATFORM_ADMIN_SECRET = "sdr1-cleanup-test-secret";
process.env["PLATFORM_ADMIN_SECRET"] = PLATFORM_ADMIN_SECRET;

const CONFIRM = "DELETE_SDR1_LEGACY_OPEN_INVOICES";
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
  const userId = rid("usdr1");

  // Legacy rows in the target org. Target names use entries from the real
  // SDR1 list that are obviously test patients: Sally Test, Jane Doe,
  // John Toe, Ohhh Crumbs, Zurko/Cindee.
  const matchTargetId = rid("lcm1"); // "Sally Test", era, has invoiceId → deleted
  const matchVariantId = rid("lcm2"); // "Zurko, Cindee" variant, era, no invoiceId → deleted
  const nonTargetId = rid("lcnt"); // "Random Person", era → kept
  const outOfEraId = rid("lcoe"); // "Jane Doe" but pre-era → kept (ambiguous)
  const badBlobId = rid("lcbb"); // unparseable blob → kept (ambiguous)
  const otherOrgLegacyId = rid("lcoo"); // "Sally Test" in ANOTHER org → kept

  // Canonical rows in the target org.
  const linkedCaseId = rid("ccl"); // 26-40 "Sally Test" → deleted (number+name)
  const collisionCaseId = rid("ccc"); // 26-77 "Different Patient" → kept (collision)
  const linkedInvoiceId = rid("invl"); // INV-26-40 "Sally Test" → deleted
  const collisionInvoiceId = rid("invc"); // INV-26-77 "Different Patient" → kept
  const unrelatedInvoiceId = rid("invu"); // INV-26-999 unrelated → kept

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
      { id: labOrgId, type: "lab", name: "SDR1 Cleanup Test Lab" },
      { id: otherOrgId, type: "lab", name: "SDR1 Cleanup Other Lab" },
      {
        id: practiceId,
        type: "provider",
        name: "SDR1 Cleanup Practice",
        parentLabOrganizationId: labOrgId,
      },
    ]);

    await db.insert(labCases).values([
      {
        id: matchTargetId,
        ownerId: userId,
        organizationId: labOrgId,
        caseData: JSON.stringify({
          caseNumber: "26-40",
          patientName: "Sally Test",
          invoiceId: "1778506322824test0001",
          createdAt: ERA_MS,
        }),
      },
      {
        id: matchVariantId,
        ownerId: userId,
        organizationId: labOrgId,
        caseData: JSON.stringify({
          caseNumber: "26-22B",
          patientName: "Zurko, Cindee",
          createdAt: String(ERA_MS), // numeric-string format also seen in prod
        }),
      },
      {
        id: nonTargetId,
        ownerId: userId,
        organizationId: labOrgId,
        caseData: JSON.stringify({
          caseNumber: "26-1",
          patientName: "Random Person",
          createdAt: ERA_MS,
        }),
      },
      {
        id: outOfEraId,
        ownerId: userId,
        organizationId: labOrgId,
        caseData: JSON.stringify({
          caseNumber: "26-9",
          patientName: "Jane Doe",
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
          caseNumber: "26-40",
          patientName: "Sally Test",
          createdAt: ERA_MS,
        }),
      },
    ]);

    const caseBase = {
      labOrganizationId: labOrgId,
      providerOrganizationId: practiceId,
      doctorName: "Dr. Sdr1",
      status: "received",
      createdByUserId: userId,
    };
    await db.insert(cases).values([
      {
        id: linkedCaseId,
        caseNumber: "26-40",
        ...caseBase,
        patientFirstName: "Sally",
        patientLastName: "Test",
      },
      {
        id: collisionCaseId,
        caseNumber: "26-22B",
        ...caseBase,
        patientFirstName: "Different",
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
        invoiceNumber: "INV-26-40",
        ...invBase,
        displayMetadataJson: { patientName: "Sally Test" },
      },
      {
        id: collisionInvoiceId,
        invoiceNumber: "INV-26-22B",
        ...invBase,
        displayMetadataJson: { patientName: "Different Patient" },
      },
      {
        id: unrelatedInvoiceId,
        invoiceNumber: "INV-26-999",
        ...invBase,
        displayMetadataJson: { patientName: "Sally Test" },
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
          "sdr1-legacy-cleanup",
        ]),
      );
    await db
      .delete(invoices)
      .where(inArray(invoices.id, [linkedInvoiceId, collisionInvoiceId, unrelatedInvoiceId]));
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
      .where(inArray(invoices.id, [linkedInvoiceId, collisionInvoiceId, unrelatedInvoiceId]));
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
    expect(res.body.matched).toBe(2); // Sally Test + Zurko, Cindee
    expect(res.body.nonTargetSkipped).toBe(1); // Random Person
    expect(res.body.ambiguousSkipped).toBe(2); // out-of-era Jane Doe + bad blob

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

  it("live run soft-deletes matched + strictly-linked rows only", async () => {
    const res = await adminPost({ dryRun: false, confirm: CONFIRM });
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
    const res = await adminPost({ dryRun: false, confirm: CONFIRM });
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
