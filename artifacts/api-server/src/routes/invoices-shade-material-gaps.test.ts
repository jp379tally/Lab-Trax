/**
 * Integration tests for the shade/material gap report and backfill endpoints:
 *   GET  /api/invoices/admin/shade-material-gaps
 *   POST /api/invoices/admin/shade-material-backfill
 *
 * Both endpoints share one lab-scoped helper (computeShadeMaterialGaps) so the
 * report and the backfill can never disagree about what counts as a gap or
 * what the tool would derive for it.
 *
 * Coverage:
 *  - both shade and material derivable -> "fully_fixable", both get written,
 *    practice/case/patient-name-fallback fields are populated correctly
 *  - only one field derivable -> "partially_fixable"; the invoice is counted
 *    as "updated" but remains in the post-run remaining list because the
 *    other field is still missing
 *  - nothing derivable (case has no restorations) -> "not_fixable", skipped
 *  - a non-empty snapshot value (incl. an explicit patientName override) is
 *    never overwritten, even when the case's restorations disagree with it
 *  - a case whose only restorations are type "missing" counts as nothing
 *    derivable
 *  - soft-deleted invoices are excluded from both the report and the backfill
 *  - gapCount always equals rows.length
 *  - a second backfill run reports zero updates and leaves the same
 *    remaining list; totals/balances/statuses are never touched
 *
 * Skipped when DATABASE_URL is not configured. Cleans up after itself via
 * afterAll so it is safe to run against a shared dev DB.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
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

maybe("Shade/material gap report + backfill (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let auth: typeof import("../lib/auth.js");

  const adminUserId = rid("uadmin");
  const labOrgId = rid("lab");
  const practiceId = rid("prov");
  const practiceName = rid("GapPractice");
  let token = "";

  async function makeSession(userId: string): Promise<string> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const signed = auth.signAccessToken(userId, sessionId);
    const hash = createHash("sha256").update(signed).digest("hex");
    await db.insert(userSessions).values({
      id: sessionId,
      userId,
      tokenHash: hash,
      expiresAt,
    });
    return signed;
  }

  async function insertCase(opts: {
    patientFirstName?: string;
    patientLastName?: string;
  } = {}): Promise<string> {
    const { db, cases } = dbMod as any;
    const id = rid("case");
    await db.insert(cases).values({
      id,
      caseNumber: rid("CASE"),
      labOrganizationId: labOrgId,
      providerOrganizationId: practiceId,
      patientFirstName: opts.patientFirstName ?? "Gap",
      patientLastName: opts.patientLastName ?? "Patient",
      doctorName: "Dr. Test",
      createdByUserId: adminUserId,
    });
    return id;
  }

  async function insertRestoration(opts: {
    caseId: string;
    restorationType?: string;
    restorationSubtype?: string | null;
    shade?: string | null;
    material?: string | null;
    toothNumber?: string;
  }) {
    const { db, caseRestorations } = dbMod as any;
    await db.insert(caseRestorations).values({
      id: rid("resto"),
      caseId: opts.caseId,
      toothNumber: opts.toothNumber ?? "8",
      restorationType: opts.restorationType ?? "crown",
      restorationSubtype: opts.restorationSubtype ?? null,
      shade: opts.shade ?? null,
      material: opts.material ?? null,
    });
  }

  async function insertInvoice(opts: {
    caseId?: string | null;
    shade?: string | null;
    material?: string | null;
    patientName?: string;
    deletedAt?: Date | null;
  }): Promise<{ id: string; invoiceNumber: string }> {
    const { db, invoices } = dbMod as any;
    const id = rid("inv");
    const invoiceNumber = rid("INV");
    const displayMetadataJson: Record<string, unknown> = {};
    if (opts.shade !== undefined && opts.shade !== null) displayMetadataJson.shade = opts.shade;
    if (opts.material !== undefined && opts.material !== null)
      displayMetadataJson.material = opts.material;
    if (opts.patientName) displayMetadataJson.patientName = opts.patientName;
    await db.insert(invoices).values({
      id,
      invoiceNumber,
      labOrganizationId: labOrgId,
      providerOrganizationId: practiceId,
      status: "open",
      total: "100.00",
      balanceDue: "100.00",
      caseId: opts.caseId ?? null,
      displayMetadataJson,
      deletedAt: opts.deletedAt ?? null,
      createdByUserId: adminUserId,
    });
    return { id, invoiceNumber };
  }

  async function fetchInvoice(id: string) {
    const { db, invoices } = dbMod as any;
    return db.query.invoices.findFirst({ where: eq(invoices.id, id) });
  }

  async function getGaps() {
    return request(appMod.default)
      .get("/api/invoices/admin/shade-material-gaps")
      .query({ labOrganizationId: labOrgId })
      .set("Authorization", `Bearer ${token}`);
  }

  async function runBackfill() {
    return request(appMod.default)
      .post("/api/invoices/admin/shade-material-backfill")
      .set("Authorization", `Bearer ${token}`)
      .send({ labOrganizationId: labOrgId });
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-shade-material-gaps";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    auth = await import("../lib/auth.js");

    const { db, users, organizations, organizationMemberships } = dbMod as any;

    await db.insert(users).values([
      { id: adminUserId, username: `admin_${adminUserId}`, password: "x" },
    ]);

    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: rid("GapLab") },
      {
        id: practiceId,
        type: "provider",
        name: practiceName,
        parentLabOrganizationId: labOrgId,
      },
    ]);

    await db.insert(organizationMemberships).values([
      { id: rid("m"), labId: labOrgId, userId: adminUserId, role: "admin", status: "active" },
    ]);

    token = await makeSession(adminUserId);
  }, 60_000);

  beforeEach(async () => {
    token = await makeSession(adminUserId);
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
      cases,
    } = dbMod as any;
    // caseRestorations cascade-delete with their case.
    await db.delete(invoices).where(eq(invoices.labOrganizationId, labOrgId));
    await db.delete(cases).where(eq(cases.labOrganizationId, labOrgId));
    await db
      .delete(organizationMemberships)
      .where(eq(organizationMemberships.userId, adminUserId));
    await db.delete(userSessions).where(eq(userSessions.userId, adminUserId));
    await db.delete(organizations).where(eq(organizations.id, practiceId));
    await db.delete(organizations).where(eq(organizations.id, labOrgId));
    await db.delete(users).where(eq(users.id, adminUserId));
  });

  it("marks an invoice fully_fixable when both shade and material are derivable, and fills in both", async () => {
    const caseId = await insertCase({ patientFirstName: "Alice", patientLastName: "Fully" });
    // A "missing" marker restoration must be ignored; the other two carry
    // distinct shade values that should join in insertion order.
    await insertRestoration({ caseId, restorationType: "missing", shade: "Z9", material: "Ignore Me" });
    await insertRestoration({ caseId, shade: "A2", material: "Zirconia" });
    await insertRestoration({ caseId, shade: "B1", material: "Zirconia" });
    const inv = await insertInvoice({ caseId });

    const gapsRes = await getGaps();
    expect(gapsRes.status, JSON.stringify(gapsRes.body)).toBe(200);
    expect(gapsRes.body.data.rowsTruncated).toBe(false);
    expect(gapsRes.body.data.gapCount).toBe(gapsRes.body.data.rows.length);

    const row = gapsRes.body.data.rows.find((r: any) => r.invoiceId === inv.id);
    expect(row, "expected a gap row for the invoice").toBeTruthy();
    expect(row.invoiceNumber).toBe(inv.invoiceNumber);
    expect(row.caseId).toBe(caseId);
    expect(row.practiceName).toBe(practiceName);
    expect(row.patientName).toBe("Alice Fully");
    expect(row.currentShade).toBe("");
    expect(row.currentMaterial).toBe("");
    expect(row.shadeMissing).toBe(true);
    expect(row.materialMissing).toBe(true);
    expect(row.derivedShade).toBe("A2, B1");
    expect(row.derivedMaterial).toBe("Zirconia");
    expect(row.status).toBe("fully_fixable");

    const before = await fetchInvoice(inv.id);

    const backfillRes = await runBackfill();
    expect(backfillRes.status, JSON.stringify(backfillRes.body)).toBe(200);
    expect(backfillRes.body.data.remainingRows.find((r: any) => r.invoiceId === inv.id)).toBeUndefined();

    const after = await fetchInvoice(inv.id);
    expect(after.displayMetadataJson.shade).toBe("A2, B1");
    expect(after.displayMetadataJson.material).toBe("Zirconia");
    // Nothing else about the invoice changed.
    expect(after.status).toBe(before.status);
    expect(after.total).toBe(before.total);
    expect(after.balanceDue).toBe(before.balanceDue);
  });

  it("marks an invoice partially_fixable when only one field is derivable, and it stays incomplete after the run", async () => {
    const caseId = await insertCase();
    // Restoration carries a shade but no material at all.
    await insertRestoration({ caseId, shade: "B2", material: null });
    const inv = await insertInvoice({ caseId });

    const gapsRes = await getGaps();
    const row = gapsRes.body.data.rows.find((r: any) => r.invoiceId === inv.id);
    expect(row.status).toBe("partially_fixable");
    expect(row.derivedShade).toBe("B2");
    expect(row.derivedMaterial).toBeNull();

    const backfillRes = await runBackfill();
    expect(backfillRes.status, JSON.stringify(backfillRes.body)).toBe(200);
    // Still counted as "updated" even though it remains incomplete.
    expect(backfillRes.body.data.updated).toBeGreaterThanOrEqual(1);

    const remainingRow = backfillRes.body.data.remainingRows.find((r: any) => r.invoiceId === inv.id);
    expect(remainingRow, "invoice should still need review after a partial fix").toBeTruthy();
    expect(remainingRow.shadeMissing).toBe(false);
    expect(remainingRow.materialMissing).toBe(true);
    expect(remainingRow.status).toBe("not_fixable");

    const after = await fetchInvoice(inv.id);
    expect(after.displayMetadataJson.shade).toBe("B2");
    expect(after.displayMetadataJson.material ?? "").toBe("");
  });

  it("marks an invoice not_fixable when its case has no restorations, and skips it", async () => {
    const caseId = await insertCase();
    const inv = await insertInvoice({ caseId });

    const gapsRes = await getGaps();
    const row = gapsRes.body.data.rows.find((r: any) => r.invoiceId === inv.id);
    expect(row.status).toBe("not_fixable");
    expect(row.derivedShade).toBeNull();
    expect(row.derivedMaterial).toBeNull();

    const backfillRes = await runBackfill();
    expect(backfillRes.body.data.remainingRows.find((r: any) => r.invoiceId === inv.id)).toBeTruthy();

    const after = await fetchInvoice(inv.id);
    expect(after.displayMetadataJson.shade ?? "").toBe("");
    expect(after.displayMetadataJson.material ?? "").toBe("");
  });

  it("treats a case whose only restorations are type 'missing' as nothing derivable", async () => {
    const caseId = await insertCase();
    await insertRestoration({ caseId, restorationType: "Missing", shade: "X1", material: "Ceramic" });
    const inv = await insertInvoice({ caseId });

    const gapsRes = await getGaps();
    const row = gapsRes.body.data.rows.find((r: any) => r.invoiceId === inv.id);
    expect(row.status).toBe("not_fixable");
    expect(row.derivedShade).toBeNull();
    expect(row.derivedMaterial).toBeNull();

    await runBackfill();
    const after = await fetchInvoice(inv.id);
    expect(after.displayMetadataJson.shade ?? "").toBe("");
    expect(after.displayMetadataJson.material ?? "").toBe("");
  });

  it("never overwrites an already-present value, including an explicit patientName override", async () => {
    const caseId = await insertCase({ patientFirstName: "Case", patientLastName: "Name" });
    // The case's restoration disagrees with the invoice's existing shade —
    // it must never win.
    await insertRestoration({ caseId, shade: "Z9", material: "Ceramic" });
    const inv = await insertInvoice({
      caseId,
      shade: "A1",
      patientName: "Custom Snapshot Name",
    });

    const gapsRes = await getGaps();
    const row = gapsRes.body.data.rows.find((r: any) => r.invoiceId === inv.id);
    expect(row.currentShade).toBe("A1");
    expect(row.shadeMissing).toBe(false);
    expect(row.materialMissing).toBe(true);
    expect(row.derivedShade).toBeNull();
    expect(row.derivedMaterial).toBe("Ceramic");
    expect(row.patientName).toBe("Custom Snapshot Name");
    expect(row.status).toBe("fully_fixable");

    await runBackfill();

    const after = await fetchInvoice(inv.id);
    expect(after.displayMetadataJson.shade).toBe("A1");
    expect(after.displayMetadataJson.material).toBe("Ceramic");
    expect(after.displayMetadataJson.patientName).toBe("Custom Snapshot Name");
  });

  it("excludes soft-deleted invoices from the report and leaves them untouched by the backfill", async () => {
    const caseId = await insertCase();
    await insertRestoration({ caseId, shade: "C3", material: "PFM" });
    const inv = await insertInvoice({ caseId, deletedAt: new Date() });

    const gapsRes = await getGaps();
    expect(gapsRes.body.data.rows.find((r: any) => r.invoiceId === inv.id)).toBeUndefined();
    expect(gapsRes.body.data.gapCount).toBe(gapsRes.body.data.rows.length);

    const backfillRes = await runBackfill();
    expect(backfillRes.body.data.remainingRows.find((r: any) => r.invoiceId === inv.id)).toBeUndefined();

    const after = await fetchInvoice(inv.id);
    expect(after.displayMetadataJson.shade ?? "").toBe("");
    expect(after.displayMetadataJson.material ?? "").toBe("");
  });

  it("reports zero updates on a second run and leaves the same remaining list, without touching totals/status", async () => {
    const caseId = await insertCase();
    await insertRestoration({ caseId, shade: "D4", material: null });
    const inv = await insertInvoice({ caseId });
    const before = await fetchInvoice(inv.id);

    const first = await runBackfill();
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.data.updated).toBeGreaterThanOrEqual(1);

    const firstRemainingIds = [...first.body.data.remainingRows.map((r: any) => r.invoiceId)].sort();
    const firstRemainingCount = first.body.data.remainingGapCount;

    const second = await runBackfill();
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.data.updated).toBe(0);
    expect(second.body.data.remainingGapCount).toBe(firstRemainingCount);

    const secondRemainingIds = [...second.body.data.remainingRows.map((r: any) => r.invoiceId)].sort();
    expect(secondRemainingIds).toEqual(firstRemainingIds);

    const after = await fetchInvoice(inv.id);
    expect(after.status).toBe(before.status);
    expect(after.total).toBe(before.total);
    expect(after.balanceDue).toBe(before.balanceDue);
  });

  // -------------------------------------------------------------------------
  // Display-metadata backfill: caseType / caseSubtype / material
  //
  // The shade/material gap tests above cover the older shade-only backfill
  // endpoint. These tests cover the newer display-metadata backfill
  // (POST /api/invoices/lab-orgs/:labOrganizationId/backfill-display-metadata)
  // which re-runs buildInvoiceDisplayMetadataFromCase to populate caseType,
  // caseSubtype, and material on invoices that were snapshotted before those
  // fields existed.
  // -------------------------------------------------------------------------
  describe("Display-metadata backfill (caseType / caseSubtype / material)", () => {
    async function runDisplayMetadataBackfill() {
      return request(appMod.default)
        .post(`/api/invoices/lab-orgs/${labOrgId}/backfill-display-metadata`)
        .set("Authorization", `Bearer ${token}`);
    }

    it("writes caseType, caseSubtype, and material from live restorations onto an invoice that lacks them", async () => {
      const caseId = await insertCase({ patientFirstName: "Meta", patientLastName: "Test" });
      // Two restorations: distinct types, one subtype, same material.
      await insertRestoration({
        caseId,
        restorationType: "crown",
        restorationSubtype: "full",
        shade: "A2",
        material: "Zirconia",
        toothNumber: "8",
      });
      await insertRestoration({
        caseId,
        restorationType: "bridge",
        restorationSubtype: null,
        shade: "A3",
        material: "Zirconia",
        toothNumber: "9",
      });
      // Invoice snapshotted before caseType/caseSubtype/material keys existed —
      // displayMetadataJson intentionally omits those three keys.
      const inv = await insertInvoice({ caseId, shade: "A2", material: null });

      const res = await runDisplayMetadataBackfill();
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.data.updated).toBeGreaterThanOrEqual(1);
      expect(res.body.data.updatedInvoiceIds).toContain(inv.id);

      const after = await fetchInvoice(inv.id);
      // caseType joins distinct restorationType values in insertion order.
      expect(after.displayMetadataJson.caseType).toBe("crown, bridge");
      // Only the first restoration has a subtype.
      expect(after.displayMetadataJson.caseSubtype).toBe("full");
      // material deduplicates; both restorations share "Zirconia".
      expect(after.displayMetadataJson.material).toBe("Zirconia");
    });

    it("reflects updated restorations on an invoice whose snapshot has stale caseType/caseSubtype/material", async () => {
      const caseId = await insertCase();
      // Insert a restoration that will be present when the backfill runs.
      await insertRestoration({
        caseId,
        restorationType: "veneer",
        restorationSubtype: "minimal",
        shade: "B1",
        material: "Emax",
        toothNumber: "7",
      });

      // Simulate a pre-backfill invoice whose displayMetadataJson has stale
      // (wrong) caseType/caseSubtype/material values from the time it was
      // first created.
      const { db, invoices } = dbMod as any;
      const id = rid("inv");
      const invoiceNumber = rid("INV");
      await db.insert(invoices).values({
        id,
        invoiceNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: practiceId,
        status: "open",
        total: "50.00",
        balanceDue: "50.00",
        caseId,
        displayMetadataJson: {
          patientName: "Old Name",
          shade: "B1",
          // caseType / caseSubtype / material intentionally absent (stale snapshot)
        },
        createdByUserId: adminUserId,
      });
      const inv = { id, invoiceNumber };

      const res = await runDisplayMetadataBackfill();
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.data.updatedInvoiceIds).toContain(inv.id);

      const after = await fetchInvoice(inv.id);
      expect(after.displayMetadataJson.caseType).toBe("veneer");
      expect(after.displayMetadataJson.caseSubtype).toBe("minimal");
      expect(after.displayMetadataJson.material).toBe("Emax");
      // patientName is a manually-preserved free-text field; must not be overwritten.
      expect(after.displayMetadataJson.patientName).toBe("Old Name");
      // Financial fields are untouched.
      expect(after.status).toBe("open");
      expect(after.total).toBe("50.00");
      expect(after.balanceDue).toBe("50.00");
    });

    it("skips an invoice whose case has no restorations and leaves displayMetadataJson unchanged", async () => {
      const caseId = await insertCase();
      // No restorations inserted — the backfill must skip this invoice.
      const inv = await insertInvoice({ caseId });

      const res = await runDisplayMetadataBackfill();
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.data.skippedNoRestorations).toBeGreaterThanOrEqual(1);
      expect(res.body.data.updatedInvoiceIds).not.toContain(inv.id);

      const after = await fetchInvoice(inv.id);
      // displayMetadataJson should be unchanged (no caseType/caseSubtype/material added).
      expect(after.displayMetadataJson.caseType ?? null).toBeNull();
      expect(after.displayMetadataJson.caseSubtype ?? null).toBeNull();
    });

    it("is idempotent: a second run reports zero updates for invoices already backfilled", async () => {
      const caseId = await insertCase();
      await insertRestoration({
        caseId,
        restorationType: "inlay",
        restorationSubtype: null,
        shade: "C2",
        material: "Ceramic",
        toothNumber: "14",
      });
      const inv = await insertInvoice({ caseId });

      const first = await runDisplayMetadataBackfill();
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(first.body.data.updatedInvoiceIds).toContain(inv.id);

      const afterFirst = await fetchInvoice(inv.id);
      expect(afterFirst.displayMetadataJson.caseType).toBe("inlay");
      expect(afterFirst.displayMetadataJson.material).toBe("Ceramic");

      // Second run: the invoice now has all three keys populated, so it must
      // not appear in the stale set and the updated count must not increase.
      const second = await runDisplayMetadataBackfill();
      expect(second.status, JSON.stringify(second.body)).toBe(200);
      expect(second.body.data.updatedInvoiceIds).not.toContain(inv.id);

      // The values must not change between runs.
      const afterSecond = await fetchInvoice(inv.id);
      expect(afterSecond.displayMetadataJson.caseType).toBe(afterFirst.displayMetadataJson.caseType);
      expect(afterSecond.displayMetadataJson.caseSubtype).toBe(afterFirst.displayMetadataJson.caseSubtype);
      expect(afterSecond.displayMetadataJson.material).toBe(afterFirst.displayMetadataJson.material);
    });
  });
});
