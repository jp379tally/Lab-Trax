/**
 * Regression suite: Mobile AI Reader case sync + invoice generation.
 *
 * Covers two regressions found after Build 214 TestFlight:
 *
 *   (1) Invoice not generated — the generate-invoice endpoint only looked up
 *       the canonical `cases` table. Mobile cases live in `lab_cases` (the
 *       legacy blob store), so it always returned 404 and no invoice was
 *       created on the server.
 *
 *   (2) Mobile cases not visible on web/desktop — GET /api/cases was already
 *       bridging lab_cases into its response (with _source:"mobile"), so this
 *       was not actually broken; but we guard it here to prevent regressions.
 *
 * The DB-gated suite (requires DATABASE_URL):
 *   (a) POST /api/legacy/cases stores the case in lab_cases
 *   (b) GET  /api/cases returns it with _source:"mobile" (sync visible)
 *   (c) POST /api/invoices/cases/:id/generate-invoice returns 200/201 for a
 *       legacy case and creates a real invoice row
 *   (d) The invoice carries correct labOrganizationId + patient/doctor metadata
 *   (e) Calling generate-invoice a second time is idempotent (200, same row)
 *   (f) generate-invoice for a completely unknown id still returns 404
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray, and } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import request from "supertest";

import { vi } from "vitest";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(os.tmpdir(), "labtrax-test-media-sync"),
  extractMediaFileName: () => null,
  extractMediaFilenamesFromText: () => [],
}));

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

const SHOULD_RUN_DB = !!process.env["DATABASE_URL"];
const maybeDb = SHOULD_RUN_DB ? describe : describe.skip;

maybeDb("Mobile sync + invoice — DB regression suite", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let auth: typeof import("../lib/auth.js");

  const labOrgId = rid("lab");
  const mobileUserId = rid("umob");
  let mobileToken = "";

  async function makeSession(userId: string): Promise<string> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const token = auth.signAccessToken(userId, sessionId);
    const hash = createHash("sha256").update(token).digest("hex");
    await db.insert(userSessions).values({ id: sessionId, userId, tokenHash: hash, expiresAt });
    return token;
  }

  async function waitForBlockingEvents(
    blockerPid: number,
    expectedEvents: string[],
  ): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const result = await (dbMod as any).pool.query(
        `SELECT wait_event
           FROM pg_stat_activity
          WHERE $1 = ANY(pg_blocking_pids(pid))`,
        [blockerPid],
      );
      const remaining = [...expectedEvents];
      for (const row of result.rows as Array<{ wait_event: string | null }>) {
        const index = remaining.indexOf(row.wait_event ?? "");
        if (index >= 0) remaining.splice(index, 1);
      }
      if (remaining.length === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(
      `Timed out waiting for blocked PostgreSQL events: ${expectedEvents.join(", ")}`,
    );
  }

  beforeAll(async () => {
    fs.mkdirSync(path.join(os.tmpdir(), "labtrax-test-media-sync"), { recursive: true });
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-sync";

    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    auth = await import("../lib/auth.js");

    const { db, organizations, users, organizationMemberships } = dbMod as any;

    await db.insert(users).values([
      { id: mobileUserId, username: `mob_${mobileUserId}`, password: "testpass" },
    ]);
    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: "Mobile Sync Test Lab" },
    ]);
    await db.insert(organizationMemberships).values([
      { id: rid("m"), labId: labOrgId, userId: mobileUserId, role: "admin", status: "active" },
    ]);

    mobileToken = await makeSession(mobileUserId);
  });

  // Refresh session token before every test so a concurrent user_sessions
  // wipe does not invalidate the shared token mid-suite.
  beforeEach(async () => {
    mobileToken = await makeSession(mobileUserId);
  });

  afterAll(async () => {
    if (!SHOULD_RUN_DB) return;
    const {
      db,
      organizations,
      users,
      invoices,
      labCases,
      organizationMemberships,
      userSessions,
      auditLogs,
    } = dbMod as any;
    await db.delete(auditLogs).where(eq(auditLogs.organizationId, labOrgId));
    await db.delete(invoices).where(eq(invoices.labOrganizationId, labOrgId));
    await db.delete(labCases).where(eq(labCases.organizationId, labOrgId));
    await db
      .delete(organizationMemberships)
      .where(eq(organizationMemberships.userId, mobileUserId));
    await db.delete(userSessions).where(eq(userSessions.userId, mobileUserId));
    await db.delete(organizations).where(eq(organizations.id, labOrgId));
    await db.delete(users).where(eq(users.id, mobileUserId));
  });

  // ── (a) POST /api/legacy/cases stores the case ─────────────────────────────
  it("(a) POST /api/legacy/cases stores case in lab_cases", async () => {
    const caseId = rid("case");
    const caseBlob = {
      id: caseId,
      caseNumber: "26-99",
      patientName: "John Doe",
      doctorName: "Dr. Synthetic063",
      toothIndices: "#14, #15",
      shade: "A2",
      material: "Zirconia",
      caseType: "crown",
      status: "INTAKE",
      affiliationKey: `org:${labOrgId}`,
    };

    const r = await request(appMod.default)
      .post("/api/legacy/cases")
      .set("Authorization", `Bearer ${mobileToken}`)
      .send({
        id: caseId,
        ownerId: mobileUserId,
        caseData: JSON.stringify(caseBlob),
      });

    expect(r.status).toBe(200);

    const { db, labCases } = dbMod as any;
    const row = await db.query.labCases.findFirst({
      where: eq(labCases.id, caseId),
    });
    expect(row).toBeDefined();
    expect(row.organizationId).toBe(labOrgId);

    const parsed = JSON.parse(row.caseData);
    expect(parsed.caseNumber).toBe("26-99");
    expect(parsed.patientName).toBe("John Doe");
    expect(parsed.doctorName).toBe("Dr. Synthetic063");
  });

  // ── (b) GET /api/cases returns the mobile case with _source:"mobile" ────────
  it("(b) GET /api/cases includes the mobile case with _source:'mobile'", async () => {
    const caseId = rid("case");
    const caseBlob = {
      id: caseId,
      caseNumber: "26-100",
      patientName: "Jane Molar",
      doctorName: "Dr. Sync",
      toothIndices: "#3",
      status: "INTAKE",
      affiliationKey: `org:${labOrgId}`,
    };

    const post = await request(appMod.default)
      .post("/api/legacy/cases")
      .set("Authorization", `Bearer ${mobileToken}`)
      .send({
        id: caseId,
        ownerId: mobileUserId,
        caseData: JSON.stringify(caseBlob),
      });
    expect(post.status).toBe(200);

    const list = await request(appMod.default)
      .get("/api/cases")
      .set("Authorization", `Bearer ${mobileToken}`);

    expect(list.status).toBe(200);
    const cases: any[] = list.body.data ?? list.body;
    const found = cases.find((c: any) => c.id === caseId);
    expect(found, "mobile case must appear in GET /api/cases").toBeDefined();
    expect(found._source).toBe("mobile");
    expect(found.labOrganizationId).toBe(labOrgId);
    expect(found.caseNumber).toBe("26-100");
  });

  // ── (c) generate-invoice creates an invoice for a legacy case ───────────────
  it("(c) POST generate-invoice returns 201 and creates invoice for legacy case", async () => {
    const caseId = rid("case");
    const caseBlob = {
      id: caseId,
      caseNumber: `26-INV-TEST-${caseId}`,
      patientName: "Alice Crown",
      doctorName: "Dr. Incisor",
      toothIndices: "#8, #9",
      shade: "B1",
      material: "PFM",
      status: "INTAKE",
      affiliationKey: `org:${labOrgId}`,
    };

    const sync = await request(appMod.default)
      .post("/api/legacy/cases")
      .set("Authorization", `Bearer ${mobileToken}`)
      .send({
        id: caseId,
        ownerId: mobileUserId,
        caseData: JSON.stringify(caseBlob),
      });
    expect(sync.status).toBe(200);

    const r = await request(appMod.default)
      .post(`/api/invoices/cases/${caseId}/generate-invoice`)
      .set("Authorization", `Bearer ${mobileToken}`);

    expect(r.status).toBe(201);
    expect(r.body.ok).toBe(true);
    const inv = r.body.data ?? r.body;
    expect(inv.id).toBeTruthy();
    expect(inv.invoiceNumber).toBe(`INV-26-INV-TEST-${caseId}`);
  });

  // ── (d) Invoice has correct org + metadata from the legacy blob ─────────────
  it("(d) Generated invoice has correct labOrganizationId and patient/doctor metadata", async () => {
    const caseId = rid("case");
    const caseBlob = {
      id: caseId,
      caseNumber: `26-META-${caseId}`,
      patientName: "Bob Premolar",
      doctorName: "Dr. Metadata",
      toothIndices: "#20",
      shade: "A3",
      material: "Zirconia",
      status: "INTAKE",
      affiliationKey: `org:${labOrgId}`,
    };

    await request(appMod.default)
      .post("/api/legacy/cases")
      .set("Authorization", `Bearer ${mobileToken}`)
      .send({
        id: caseId,
        ownerId: mobileUserId,
        caseData: JSON.stringify(caseBlob),
      });

    const r = await request(appMod.default)
      .post(`/api/invoices/cases/${caseId}/generate-invoice`)
      .set("Authorization", `Bearer ${mobileToken}`);

    expect(r.status).toBe(201);
    const inv = r.body.data ?? r.body;
    expect(inv.labOrganizationId).toBe(labOrgId);
    expect(inv.providerOrganizationId).toBeNull();

    const meta = inv.displayMetadataJson as Record<string, unknown>;
    expect(meta.patientName).toBe("Bob Premolar");
    expect(meta.billTo).toBe("Dr. Metadata");
    expect(meta.teeth).toBe("#20");
    expect(meta.shade).toBe("A3");
  });

  // ── (e) generate-invoice is idempotent ──────────────────────────────────────
  it("(e) Calling generate-invoice twice returns the same invoice (idempotent)", async () => {
    const caseId = rid("case");
    const caseBlob = {
      id: caseId,
      caseNumber: `26-IDEM-${caseId}`,
      patientName: "Carl Canine",
      doctorName: "Dr. Idempotent",
      status: "INTAKE",
      affiliationKey: `org:${labOrgId}`,
    };

    await request(appMod.default)
      .post("/api/legacy/cases")
      .set("Authorization", `Bearer ${mobileToken}`)
      .send({
        id: caseId,
        ownerId: mobileUserId,
        caseData: JSON.stringify(caseBlob),
      });

    const r1 = await request(appMod.default)
      .post(`/api/invoices/cases/${caseId}/generate-invoice`)
      .set("Authorization", `Bearer ${mobileToken}`);
    expect(r1.status).toBe(201);
    const inv1 = r1.body.data ?? r1.body;

    const r2 = await request(appMod.default)
      .post(`/api/invoices/cases/${caseId}/generate-invoice`)
      .set("Authorization", `Bearer ${mobileToken}`);
    expect(r2.status).toBe(200);
    const inv2 = r2.body.data ?? r2.body;

    expect(inv2.id).toBe(inv1.id);
    expect(inv2.invoiceNumber).toBe(inv1.invoiceNumber);
  });

  // ── (f) unknown case id still returns 404 ──────────────────────────────────
  it("(f) generate-invoice for unknown case id returns 404", async () => {
    const r = await request(appMod.default)
      .post("/api/invoices/cases/totally-unknown-case-id-xyz/generate-invoice")
      .set("Authorization", `Bearer ${mobileToken}`);

    expect(r.status).toBe(404);
  });

  // ── (g) duplicate patient: second case saves and gets its own invoice ───────
  //
  // Regression: the mobile duplicate-detection prompt fires when a same-named
  // patient already has cases locally.  If the user dismissed the prompt (pressed
  // Cancel / X) without choosing "Not a Remake", createCase() was never called
  // and the case was silently discarded — nothing reached the server.  This test
  // verifies the full happy-path that the user intended:
  //
  //   1. An existing lab_cases row for "Diana Dup" is already on the server.
  //   2. A brand-new case for the same patient is POSTed (simulating the user
  //      confirming past the duplicate prompt via "Not a Remake" or the fixed
  //      X/Cancel behaviour).
  //   3. The server must accept both; the second case gets its own distinct row.
  //   4. generate-invoice creates a separate invoice for the second case.
  //
  it("(g) duplicate patient name: second case is accepted and gets its own invoice", async () => {
    const caseId1 = rid("case");
    const caseId2 = rid("case");
    const sharedPatient = "Diana Dup";

    const blob1 = {
      id: caseId1,
      caseNumber: `26-DUP-1-${caseId1}`,
      patientName: sharedPatient,
      doctorName: "Dr. Dup",
      status: "INTAKE",
      affiliationKey: `org:${labOrgId}`,
    };
    const blob2 = {
      id: caseId2,
      caseNumber: `26-DUP-2-${caseId2}`,
      patientName: sharedPatient,
      doctorName: "Dr. Dup",
      status: "INTAKE",
      affiliationKey: `org:${labOrgId}`,
    };

    const r1 = await request(appMod.default)
      .post("/api/legacy/cases")
      .set("Authorization", `Bearer ${mobileToken}`)
      .send({ id: caseId1, ownerId: mobileUserId, caseData: JSON.stringify(blob1) });
    expect(r1.status).toBe(200);

    const r2 = await request(appMod.default)
      .post("/api/legacy/cases")
      .set("Authorization", `Bearer ${mobileToken}`)
      .send({ id: caseId2, ownerId: mobileUserId, caseData: JSON.stringify(blob2) });
    expect(r2.status, "second case for same patient must be accepted").toBe(200);

    const { db, labCases } = dbMod as any;
    const rows = await db.query.labCases.findMany({
      where: (t: any, { inArray: inArr }: any) => inArr(t.id, [caseId1, caseId2]),
    });
    expect(rows).toHaveLength(2);

    const inv = await request(appMod.default)
      .post(`/api/invoices/cases/${caseId2}/generate-invoice`)
      .set("Authorization", `Bearer ${mobileToken}`);
    expect(inv.status).toBe(201);
    expect(inv.body.ok).toBe(true);
    const invoiceRow = inv.body.data ?? inv.body;
    expect(invoiceRow.id).toBeTruthy();
    expect(invoiceRow.labOrganizationId).toBe(labOrgId);

    const inv1 = await request(appMod.default)
      .post(`/api/invoices/cases/${caseId1}/generate-invoice`)
      .set("Authorization", `Bearer ${mobileToken}`);
    expect(inv1.status).toBe(201);
    expect((inv1.body.data ?? inv1.body).id).not.toBe(invoiceRow.id);
  });

  // ── (i) Two different labs can each generate an invoice with the same case number ──
  //
  // Regression guard for the global unique index bug: previously
  // `invoices_invoice_number_unique` was on `(invoiceNumber)` alone, so the
  // second lab's insert silently hit onConflictDoNothing and returned the
  // FIRST lab's invoice row (or 200 with stale data). The fix changes the
  // constraint to `(labOrganizationId, invoiceNumber)`.
  //
  it("(i) two labs with the same case number each get their own distinct invoice", async () => {
    const { db, organizations, users, organizationMemberships, userSessions, invoices: invoicesTable } = dbMod as any;

    // Create a second lab + its own admin user
    const lab2Id = rid("lab2");
    const user2Id = rid("u2");
    await db.insert(users).values([{ id: user2Id, username: `u2_${user2Id}`, password: "testpass" }]);
    await db.insert(organizations).values([{ id: lab2Id, type: "lab", name: "Second Lab" }]);
    await db.insert(organizationMemberships).values([
      { id: rid("m2"), labId: lab2Id, userId: user2Id, role: "admin", status: "active" },
    ]);
    const token2 = await makeSession(user2Id);

    const sharedCaseNumber = "26-SHARED";

    // Store a case under lab1 (mobileUserId / labOrgId)
    const caseId1 = rid("clash1");
    await request(appMod.default)
      .post("/api/legacy/cases")
      .set("Authorization", `Bearer ${mobileToken}`)
      .send({
        id: caseId1,
        ownerId: mobileUserId,
        caseData: JSON.stringify({
          id: caseId1,
          caseNumber: sharedCaseNumber,
          patientName: "Pat A",
          doctorName: "Dr. A",
          status: "INTAKE",
          affiliationKey: `org:${labOrgId}`,
        }),
      })
      .expect(200);

    // Store a case with the SAME case number under lab2
    const caseId2 = rid("clash2");
    await request(appMod.default)
      .post("/api/legacy/cases")
      .set("Authorization", `Bearer ${token2}`)
      .send({
        id: caseId2,
        ownerId: user2Id,
        caseData: JSON.stringify({
          id: caseId2,
          caseNumber: sharedCaseNumber,
          patientName: "Pat B",
          doctorName: "Dr. B",
          status: "INTAKE",
          affiliationKey: `org:${lab2Id}`,
        }),
      })
      .expect(200);

    // Lab1 generates its invoice
    const r1 = await request(appMod.default)
      .post(`/api/invoices/cases/${caseId1}/generate-invoice`)
      .set("Authorization", `Bearer ${mobileToken}`);
    expect(r1.status, "lab1 invoice creation must succeed").toBe(201);
    const inv1 = r1.body.data ?? r1.body;
    expect(inv1.labOrganizationId).toBe(labOrgId);

    // Lab2 generates its invoice — must NOT collide with lab1's
    const r2 = await request(appMod.default)
      .post(`/api/invoices/cases/${caseId2}/generate-invoice`)
      .set("Authorization", `Bearer ${token2}`);
    expect(r2.status, "lab2 invoice creation must succeed (cross-lab collision bug)").toBe(201);
    const inv2 = r2.body.data ?? r2.body;
    expect(inv2.labOrganizationId).toBe(lab2Id);

    // They must be distinct rows with distinct IDs
    expect(inv2.id, "each lab must get its own invoice row").not.toBe(inv1.id);
    expect(inv1.invoiceNumber).toBe(inv2.invoiceNumber); // same number string, different lab

    // Cleanup second lab
    await db.delete(invoicesTable).where(eq(invoicesTable.labOrganizationId, lab2Id));
    await db.delete(dbMod.labCases as any).where(eq((dbMod.labCases as any).organizationId, lab2Id));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.userId, user2Id));
    await db.delete(userSessions).where(eq(userSessions.userId, user2Id));
    await db.delete(organizations).where(eq(organizations.id, lab2Id));
    await db.delete(users).where(eq(users.id, user2Id));
  });

  // ── (j) PFM alloy sub-items survive a case edit + re-sync (no doubling) ──
  //
  // Regression guard for the alloy doubling hazard:
  //
  //   syncInvoiceFromRestorations wipes and rebuilds invoice lines from
  //   case_restorations. If alloy rows are present and the sync is triggered
  //   a second time (e.g. after a PATCH to the case or a restoration edit),
  //   the per-tooth alloy child sub-items must be re-attached exactly once —
  //   one per PFM parent line — not duplicated.
  //
  // Flow:
  //   1. Create a canonical case with two PFM restorations (teeth #14, #15).
  //   2. Add per-tooth alloy charge → 2 alloy restoration rows + 1 sync.
  //   3. Assert: 2 parent invoice lines (PFM crowns) + 2 alloy child sub-items.
  //   4. Call syncInvoiceFromRestorations a second time (simulates a case edit).
  //   5. Assert: still 2 parent lines + 2 alloy children, each correctly linked.
  //
  it("(j) PFM alloy sub-items survive a case edit and re-sync without doubling", async () => {
    const {
      db,
      organizations,
      cases: casesTable,
      caseRestorations,
      invoices: invoicesTable,
      invoiceLineItems,
    } = dbMod as any;

    // A canonical case needs a providerOrganizationId (NOT NULL).
    const provOrgId = rid("prov");
    await db.insert(organizations).values([
      {
        id: provOrgId,
        type: "provider",
        name: `PFM Alloy Test Provider ${provOrgId}`,
        parentLabOrganizationId: labOrgId,
      },
    ]);

    let caseId: string | null = null;
    try {
      // ── Step 1: create a canonical case ────────────────────────────────────
      const caseR = await request(appMod.default)
        .post("/api/cases")
        .set("Authorization", `Bearer ${mobileToken}`)
        .send({
          caseNumber: `PFM-ALLOY-${rid("CN")}`,
          labOrganizationId: labOrgId,
          providerOrganizationId: provOrgId,
          patientFirstName: "Alloy",
          patientLastName: "NoDouble",
          doctorName: "Dr. PfmReSync",
          status: "received",
        });
      expect(caseR.status, JSON.stringify(caseR.body)).toBe(201);
      caseId = caseR.body.data.id as string;

      // ── Step 2: add two PFM restorations ───────────────────────────────────
      const r14 = await request(appMod.default)
        .post(`/api/cases/${caseId}/restorations`)
        .set("Authorization", `Bearer ${mobileToken}`)
        .send({ toothNumber: "14", restorationType: "PFM Crown", material: "PFM" });
      expect(r14.status, JSON.stringify(r14.body)).toBe(201);

      const r15 = await request(appMod.default)
        .post(`/api/cases/${caseId}/restorations`)
        .set("Authorization", `Bearer ${mobileToken}`)
        .send({ toothNumber: "15", restorationType: "PFM Crown", material: "PFM" });
      expect(r15.status, JSON.stringify(r15.body)).toBe(201);

      // ── Step 3: add per-tooth alloy charge → 2 alloy rows + 1st sync ──────
      const alloyR = await request(appMod.default)
        .post(`/api/cases/${caseId}/alloy-charge`)
        .set("Authorization", `Bearer ${mobileToken}`)
        .send({});
      expect(alloyR.status, JSON.stringify(alloyR.body)).toBe(201);
      expect(alloyR.body.data.added).toBe(true);

      // Confirm exactly 2 alloy restoration rows (one per PFM tooth).
      const alloyRestorations = await db
        .select()
        .from(caseRestorations)
        .where(
          and(
            eq(caseRestorations.caseId, caseId),
            eq(caseRestorations.restorationType, "Alloy"),
          ),
        );
      expect(alloyRestorations, "one alloy row per PFM tooth").toHaveLength(2);
      const alloyTeethInDb = new Set(
        alloyRestorations.map((r: any) => (r.toothNumber ?? "").trim()),
      );
      expect(alloyTeethInDb.has("14")).toBe(true);
      expect(alloyTeethInDb.has("15")).toBe(true);

      // ── Step 4: verify initial invoice structure ────────────────────────────
      // Wait for the invoice (created synchronously by POST /cases, but we
      // poll to be safe against any async lag).
      let invoice: any;
      for (let i = 0; i < 30; i++) {
        await new Promise((res) => setTimeout(res, 100));
        [invoice] = await db
          .select()
          .from(invoicesTable)
          .where(eq(invoicesTable.caseId, caseId));
        if (invoice) break;
      }
      expect(invoice, "invoice must exist after alloy charge").toBeDefined();

      const linesBefore = await db
        .select()
        .from(invoiceLineItems)
        .where(eq(invoiceLineItems.invoiceId, invoice.id));

      const parentsBefore = linesBefore.filter(
        (l: any) => l.parentLineItemId === null,
      );
      const childrenBefore = linesBefore.filter(
        (l: any) => l.parentLineItemId !== null,
      );

      // Expect 2 parent PFM lines and 2 alloy child sub-items.
      expect(parentsBefore, "2 PFM parent lines before re-sync").toHaveLength(2);
      expect(childrenBefore, "2 alloy child sub-items before re-sync").toHaveLength(2);

      // Each child must point to a distinct parent.
      const childParentIdsBefore = new Set(
        childrenBefore.map((c: any) => c.parentLineItemId),
      );
      expect(
        childParentIdsBefore.size,
        "each alloy child is under a distinct PFM parent",
      ).toBe(2);

      // Child descriptions must name the tooth.
      const alloyDescsBefore = childrenBefore
        .map((c: any) => c.description)
        .sort();
      expect(alloyDescsBefore).toContain("Alloy #14");
      expect(alloyDescsBefore).toContain("Alloy #15");

      // Edit a generated alloy child and add an invoice-only nested charge.
      // The generated edit must flow back to its restoration source, while the
      // manual parent + child must remain invoice-owned across the rebuild.
      const nestedBefore = parentsBefore.map((parent: any) => ({
        id: parent.id,
        toothNumber: parent.toothNumber,
        toothLabel: parent.toothLabel,
        description: parent.description,
        quantity: parent.quantity,
        unitPrice: Number(parent.unitPrice),
        subItems: childrenBefore
          .filter((child: any) => child.parentLineItemId === parent.id)
          .map((child: any) => ({
            id: child.id,
            toothNumber: child.toothNumber,
            toothLabel: child.toothLabel,
            description: child.description,
            quantity: child.quantity,
            unitPrice: child.description === "Alloy #14" ? 12.5 : Number(child.unitPrice),
          })),
      }));
      // Deliberately attach the manual charge to the parent whose provenance
      // is cleared below. Do not let unordered DB results hide the legacy
      // classifier mistaking "Alloy adjustment" for a generated alloy child.
      const legacyParent = nestedBefore.find((parent: any) =>
        parent.subItems.some((child: any) => child.description === "Alloy #15"));
      expect(legacyParent).toBeDefined();
      legacyParent!.subItems.push({
        description: "Alloy adjustment",
        quantity: 1,
        unitPrice: 4,
      } as any);
      nestedBefore.push({
        description: "Custom rush handling",
        quantity: 1,
        unitPrice: 9,
        subItems: [{
          description: "Weekend pickup",
          quantity: 1,
          unitPrice: 3,
        }],
      } as any);
      nestedBefore.push({
        description: "Courtesy no-charge",
        quantity: 1,
        unitPrice: 0,
        subItems: [],
      } as any);
      nestedBefore.push({
        description: "Manual discount",
        quantity: 1,
        unitPrice: -4,
        isDiscount: true,
        subItems: [],
      } as any);
      const invalidEdit = await request(appMod.default)
        .patch(`/api/invoices/${invoice.id}`)
        .set("Authorization", `Bearer ${mobileToken}`)
        .send({
          items: nestedBefore.map((item: any, idx: number) =>
            idx === 0 ? { ...item, unitPrice: "" } : item),
        });
      expect(invalidEdit.status).toBe(400);

      const edit = await request(appMod.default)
        .patch(`/api/invoices/${invoice.id}`)
        .set("Authorization", `Bearer ${mobileToken}`)
        .send({ items: nestedBefore });
      expect(edit.status, JSON.stringify(edit.body)).toBe(200);

      const alloy14 = alloyRestorations.find((row: any) => row.toothNumber === "14");
      const [updatedAlloy14] = await db
        .select()
        .from(caseRestorations)
        .where(eq(caseRestorations.id, alloy14.id));
      expect(Number(updatedAlloy14.unitPrice)).toBe(12.5);
      expect(updatedAlloy14.priceSource).toBe("manual");
      const afterEditRows = await db
        .select()
        .from(invoiceLineItems)
        .where(eq(invoiceLineItems.invoiceId, invoice.id));
      const alloy14Id = afterEditRows.find((row: any) => row.description === "Alloy #14")?.id;
      const customId = afterEditRows.find((row: any) => row.description === "Custom rush handling")?.id;
      const discountId = afterEditRows.find((row: any) => row.description === "Manual discount")?.id;
      const noCharge = afterEditRows.find((row: any) => row.description === "Courtesy no-charge");
      expect(Number(noCharge?.unitPrice)).toBe(0);
      const adjustmentBefore = afterEditRows.find((row: any) => row.description === "Alloy adjustment");
      expect(adjustmentBefore).toBeDefined();
      const alloy15Line = afterEditRows.find((row: any) => row.description === "Alloy #15");
      const alloy15Parent = afterEditRows.find((row: any) => row.id === alloy15Line.parentLineItemId);
      await db
        .update(invoiceLineItems)
        .set({
          sourceType: "manual",
          caseRestorationId: null,
          sourceKey: null,
          sourceRestorationIdsJson: null,
        })
        .where(eq(invoiceLineItems.id, alloy15Line.id));
      await db
        .update(invoiceLineItems)
        .set({
          sourceType: "manual",
          sourceKey: null,
          sourceRestorationIdsJson: null,
        })
        .where(eq(invoiceLineItems.id, alloy15Parent.id));

      // ── Step 5: re-sync (simulates a case PATCH or restoration edit) ────────
      // Import the sync function directly — the same code path that PATCH /cases,
      // PATCH /restorations/:id, and the alloy-charge endpoint all call.
      const { syncInvoiceFromRestorations: syncFn } = await import(
        "../lib/invoice-sync.js"
      );
      await syncFn({ caseId, actorUserId: null });

      // ── Step 6: assert no doubling ─────────────────────────────────────────
      const linesAfter = await db
        .select()
        .from(invoiceLineItems)
        .where(eq(invoiceLineItems.invoiceId, invoice.id));

      const parentsAfter = linesAfter.filter(
        (l: any) => l.parentLineItemId === null,
      );
      const childrenAfter = linesAfter.filter(
        (l: any) => l.parentLineItemId !== null,
      );

      expect(
        parentsAfter,
        `2 generated PFM lines plus 3 manual lines after re-sync: ${parentsAfter.map((row: any) => row.description).join(" | ")}`,
      ).toHaveLength(5);
      expect(
        childrenAfter,
        "2 alloy children plus 2 manual nested charges after re-sync",
      ).toHaveLength(4);

      // The two generated alloy children keep distinct PFM parents. The manual
      // alloy adjustment intentionally shares PFM #15, while weekend pickup
      // remains under its manual rush parent.
      const childParentIdsAfter = new Set(
        childrenAfter.map((c: any) => c.parentLineItemId),
      );
      expect(
        childParentIdsAfter.size,
        "generated and manual nested charges retain their three intended parents after re-sync",
      ).toBe(3);

      // Correct tooth labels must survive the rebuild.
      const alloyDescsAfter = childrenAfter
        .map((c: any) => c.description)
        .sort();
      expect(alloyDescsAfter).toContain("Alloy #14");
      expect(alloyDescsAfter).toContain("Alloy #15");
      const editedAlloy = childrenAfter.find((c: any) => c.description === "Alloy #14");
      expect(Number(editedAlloy.unitPrice)).toBe(12.5);
      expect(editedAlloy.id).toBe(alloy14Id);
      const adjustmentAfter = childrenAfter.find((c: any) => c.description === "Alloy adjustment");
      expect(adjustmentAfter?.id).toBe(adjustmentBefore?.id);
      expect(adjustmentAfter?.sourceType).toBe("manual");
      expect(Number(adjustmentAfter?.unitPrice)).toBe(4);
      expect(adjustmentAfter?.parentLineItemId).toBe(
        childrenAfter.find((c: any) => c.description === "Alloy #15")?.parentLineItemId,
      );
      expect(parentsAfter.find((p: any) => p.description === "Custom rush handling")?.id).toBe(customId);
      const discountAfter = parentsAfter.find(
        (p: any) => p.description === "Manual discount",
      );
      expect(discountAfter?.id).toBe(discountId);
      expect(discountAfter?.isDiscount).toBe(true);
      expect(Number(discountAfter?.unitPrice)).toBe(-4);
      expect(childrenAfter.some((c: any) => c.description === "Weekend pickup" && Number(c.unitPrice) === 3)).toBe(true);
      expect(childrenAfter.some((c: any) => c.description === "Alloy adjustment" && Number(c.unitPrice) === 4)).toBe(true);
      expect(parentsAfter.some((p: any) => p.description === "Courtesy no-charge" && Number(p.unitPrice) === 0)).toBe(true);

      // Duplicates are invoice-owned snapshots. Removing a copied generated
      // line must never delete the clinical restoration source.
      const duplicate = await request(appMod.default)
        .post(`/api/invoices/${invoice.id}/duplicate`)
        .set("Authorization", `Bearer ${mobileToken}`);
      expect(duplicate.status, JSON.stringify(duplicate.body)).toBe(201);
      const duplicateId = duplicate.body.data.id;
      const duplicateRows = await db
        .select()
        .from(invoiceLineItems)
        .where(eq(invoiceLineItems.invoiceId, duplicateId));
      expect(duplicateRows.every((row: any) =>
        row.sourceType === "manual" &&
        row.caseRestorationId == null &&
        row.sourceKey == null,
      )).toBe(true);
      expect(
        duplicateRows.find((row: any) => row.description === "Manual discount")
          ?.isDiscount,
      ).toBe(true);
      const restorationsBeforeDuplicateEdit = await db
        .select()
        .from(caseRestorations)
        .where(eq(caseRestorations.caseId, invoice.caseId!));
      const duplicateParents = duplicateRows.filter((row: any) => row.parentLineItemId == null);
      const duplicateEdit = await request(appMod.default)
        .patch(`/api/invoices/${duplicateId}`)
        .set("Authorization", `Bearer ${mobileToken}`)
        .send({
          items: duplicateParents.slice(1).map((row: any) => ({
            id: row.id,
            description: row.description,
            quantity: row.quantity,
            unitPrice: Number(row.unitPrice),
            isDiscount: !!row.isDiscount,
            subItems: duplicateRows
              .filter((child: any) => child.parentLineItemId === row.id)
              .map((child: any) => ({
                id: child.id,
                description: child.description,
                quantity: child.quantity,
                unitPrice: Number(child.unitPrice),
              })),
          })),
        });
      expect(duplicateEdit.status, JSON.stringify(duplicateEdit.body)).toBe(200);
      const restorationsAfterDuplicateEdit = await db
        .select()
        .from(caseRestorations)
        .where(eq(caseRestorations.caseId, invoice.caseId!));
      expect(restorationsAfterDuplicateEdit).toHaveLength(restorationsBeforeDuplicateEdit.length);

      // Legacy ownership must survive source removal, not just an unchanged
      // rebuild. Price the old child so retaining it would leave a real charge.
      const alloy15After = childrenAfter.find((c: any) => c.description === "Alloy #15");
      const legacyProvenance = {
        sourceType: "manual",
        caseRestorationId: null,
        sourceKey: null,
        sourceRestorationIdsJson: null,
      };
      await db.update(invoiceLineItems).set({
        ...legacyProvenance,
        unitPrice: "8.00",
        lineTotal: "8.00",
      }).where(eq(invoiceLineItems.id, alloy15After.id));
      await db.update(invoiceLineItems).set({
        sourceKey: null,
        sourceRestorationIdsJson: null,
      }).where(eq(invoiceLineItems.id, alloy15After.parentLineItemId));
      const alloy15Source = alloyRestorations.find((row: any) => row.toothNumber === "15");
      await db.delete(caseRestorations).where(eq(caseRestorations.id, alloy15Source.id));
      await syncFn({ caseId, actorUserId: null });
      const afterSourceRemoval = await db.select().from(invoiceLineItems)
        .where(eq(invoiceLineItems.invoiceId, invoice.id));
      expect(afterSourceRemoval.some((row: any) => row.description === "Alloy #15")).toBe(false);
      expect(afterSourceRemoval.find((row: any) => row.id === adjustmentBefore?.id)).toMatchObject({
        sourceType: "manual",
        parentLineItemId: alloy15After.parentLineItemId,
        unitPrice: "4.00",
      });
      const [invoiceAfterSourceRemoval] = await db.select().from(invoicesTable)
        .where(eq(invoicesTable.id, invoice.id));
      expect(Number(invoiceAfterSourceRemoval.subtotal)).toBe(
        afterSourceRemoval.reduce((sum: number, row: any) => sum + Number(row.lineTotal), 0),
      );

      // A legacy synthetic surcharge must also disappear when its generating
      // material changes, without taking the sibling manual adjustment with it.
      const crown15Source = restorationsAfterDuplicateEdit.find((row: any) =>
        row.toothNumber === "15" && row.restorationType !== "Alloy");
      expect(crown15Source).toBeDefined();
      const [pfzSource] = await db.update(caseRestorations).set({ material: "PFZ" })
        .where(eq(caseRestorations.id, crown15Source.id)).returning();
      expect(pfzSource.material).toBe("PFZ");
      await syncFn({ caseId, actorUserId: null });
      const pfzLines = await db.select().from(invoiceLineItems)
        .where(eq(invoiceLineItems.invoiceId, invoice.id));
      const layered = pfzLines.find((row: any) => row.description === "Layered Porcelain");
      expect(layered).toBeDefined();
      await db.update(invoiceLineItems).set(legacyProvenance)
        .where(eq(invoiceLineItems.id, layered!.id));
      await db.update(invoiceLineItems).set({
        sourceKey: null,
        sourceRestorationIdsJson: null,
      }).where(eq(invoiceLineItems.id, layered!.parentLineItemId));
      await db.update(caseRestorations).set({ material: "PFM" })
        .where(eq(caseRestorations.id, crown15Source.id));
      await syncFn({ caseId, actorUserId: null });
      const afterMaterialChange = await db.select().from(invoiceLineItems)
        .where(eq(invoiceLineItems.invoiceId, invoice.id));
      expect(afterMaterialChange.some((row: any) => row.description === "Layered Porcelain"),
        JSON.stringify(afterMaterialChange.map((row: any) => ({
          description: row.description, sourceType: row.sourceType,
          caseRestorationId: row.caseRestorationId, sourceKey: row.sourceKey,
          parentLineItemId: row.parentLineItemId,
        })))).toBe(false);
      expect(afterMaterialChange.find((row: any) => row.id === adjustmentBefore?.id)).toMatchObject({
        sourceType: "manual",
        parentLineItemId: layered!.parentLineItemId,
        unitPrice: "4.00",
      });
      const [invoiceAfterMaterialChange] = await db.select().from(invoicesTable)
        .where(eq(invoicesTable.id, invoice.id));
      expect(Number(invoiceAfterMaterialChange.subtotal)).toBe(
        afterMaterialChange.reduce((sum: number, row: any) => sum + Number(row.lineTotal), 0),
      );

      // Delete a source before the first sync of legacy manual-provenance
      // rows. Lost ownership is ambiguous, not permission to delete charges.
      const crown14Source = restorationsAfterDuplicateEdit.find((row: any) =>
        row.toothNumber === "14" && row.restorationType !== "Alloy");
      const parent14 = afterMaterialChange.find((row: any) =>
        row.parentLineItemId == null && row.toothNumber === 14);
      const child14 = afterMaterialChange.find((row: any) => row.description === "Alloy #14");
      await db.update(invoiceLineItems).set({
        sourceType: "manual", sourceKey: null, sourceRestorationIdsJson: null,
      }).where(eq(invoiceLineItems.id, parent14.id));
      await db.update(invoiceLineItems).set(legacyProvenance)
        .where(eq(invoiceLineItems.id, child14.id));
      await db.update(invoiceLineItems).set({ parentLineItemId: parent14.id })
        .where(eq(invoiceLineItems.id, adjustmentBefore!.id));
      await db.delete(caseRestorations).where(eq(caseRestorations.id, crown14Source.id));
      const beforeAmbiguousSync = await db.select().from(invoiceLineItems)
        .where(eq(invoiceLineItems.invoiceId, invoice.id));
      const { syncInvoiceFromRestorationsDetailed } = await import("../lib/invoice-sync.js");
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(await syncInvoiceFromRestorationsDetailed({ caseId, actorUserId: null }))
          .toMatchObject({ action: "needs_review", invoiceId: invoice.id });
        const unchanged = await db.select().from(invoiceLineItems)
          .where(eq(invoiceLineItems.invoiceId, invoice.id));
        expect(unchanged.sort((a: any, b: any) => a.id.localeCompare(b.id)))
          .toEqual([...beforeAmbiguousSync].sort((a: any, b: any) => a.id.localeCompare(b.id)));
        const [flagged] = await db.select().from(invoicesTable)
          .where(eq(invoicesTable.id, invoice.id));
        expect(flagged.subtotal).toBe(invoiceAfterMaterialChange.subtotal);
        expect(flagged.total).toBe(invoiceAfterMaterialChange.total);
        expect(flagged.balanceDue).toBe(invoiceAfterMaterialChange.balanceDue);
        expect(flagged.displayMetadataJson).toMatchObject({
          reviewedCharges: true, reviewedChargesNeedsReview: true, legacyChargesNeedsReview: true,
        });
      }
      // A header-only edit must not count as reviewing the ambiguous charges.
      const noteEdit = await request(appMod.default).patch(`/api/invoices/${invoice.id}`)
        .set("Authorization", `Bearer ${mobileToken}`).send({
          notes: "Review pending",
          displayMetadata: {
            ...(invoiceAfterMaterialChange.displayMetadataJson as any),
            reviewedCharges: false, reviewedChargesNeedsReview: false, legacyChargesNeedsReview: false,
          },
        });
      expect(noteEdit.status).toBe(200);
      const [stillFlagged] = await db.select().from(invoicesTable)
        .where(eq(invoicesTable.id, invoice.id));
      expect((stillFlagged.displayMetadataJson as any).legacyChargesNeedsReview).toBe(true);
      const confirmedReview = await request(appMod.default).patch(`/api/invoices/${invoice.id}`)
        .set("Authorization", `Bearer ${mobileToken}`).send({
          items: beforeAmbiguousSync.filter((row: any) => row.parentLineItemId == null)
            .map((row: any) => ({
              id: row.id, description: row.description, quantity: row.quantity,
              unitPrice: Number(row.unitPrice), isDiscount: row.isDiscount,
              subItems: beforeAmbiguousSync.filter((child: any) => child.parentLineItemId === row.id)
                .map((child: any) => ({
                  id: child.id, description: child.description, quantity: child.quantity,
                  unitPrice: Number(child.unitPrice),
                })),
            })),
        });
      expect(confirmedReview.status, JSON.stringify(confirmedReview.body)).toBe(200);
      const [reviewed] = await db.select().from(invoicesTable)
        .where(eq(invoicesTable.id, invoice.id));
      expect(reviewed.displayMetadataJson).toMatchObject({
        reviewedCharges: true, reviewedChargesNeedsReview: false, legacyChargesNeedsReview: false,
      });

      // The same lost source must be reviewable without any nested child.
      // Relocate children without changing their amounts, leaving a standalone
      // legacy crown whose restoration was already deleted before any sync.
      await db.update(invoiceLineItems).set({ parentLineItemId: alloy15After.parentLineItemId })
        .where(eq(invoiceLineItems.parentLineItemId, parent14.id));
      await db.update(invoiceLineItems).set({ ...legacyProvenance, toothNumber: 14 })
        .where(eq(invoiceLineItems.id, parent14.id));
      await db.update(invoicesTable).set({
        displayMetadataJson: { ...(reviewed.displayMetadataJson as any),
          reviewedCharges: false, reviewedChargesNeedsReview: false, legacyChargesNeedsReview: false },
      }).where(eq(invoicesTable.id, invoice.id));
      const standaloneLines = await db.select().from(invoiceLineItems)
        .where(eq(invoiceLineItems.invoiceId, invoice.id));
      expect(standaloneLines.some((row: any) => row.parentLineItemId === parent14.id)).toBe(false);
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(await syncInvoiceFromRestorationsDetailed({ caseId, actorUserId: null }))
          .toMatchObject({ action: "needs_review", invoiceId: invoice.id });
        const unchanged = await db.select().from(invoiceLineItems)
          .where(eq(invoiceLineItems.invoiceId, invoice.id));
        expect(unchanged.sort((a: any, b: any) => a.id.localeCompare(b.id)))
          .toEqual([...standaloneLines].sort((a: any, b: any) => a.id.localeCompare(b.id)));
        const [flagged] = await db.select().from(invoicesTable)
          .where(eq(invoicesTable.id, invoice.id));
        expect(flagged.subtotal).toBe(reviewed.subtotal);
        expect(flagged.total).toBe(reviewed.total);
        expect(flagged.balanceDue).toBe(reviewed.balanceDue);
        expect((flagged.displayMetadataJson as any).legacyChargesNeedsReview).toBe(true);
      }
    } finally {
      // Clean up the canonical case (not covered by the shared afterAll which
      // only touches labCases / lab-scoped invoices rows). Cascade handles
      // caseRestorations and caseEvents; invoiceLineItems cascade from invoices.
      if (caseId) {
        const invRows: Array<{ id: string }> = await db
          .select({ id: invoicesTable.id })
          .from(invoicesTable)
          .where(eq(invoicesTable.caseId, caseId));
        if (invRows.length) {
          await db
            .delete(invoiceLineItems)
            .where(
              inArray(
                invoiceLineItems.invoiceId,
                invRows.map((r) => r.id),
              ),
            );
          await db
            .delete(invoicesTable)
            .where(
              inArray(
                invoicesTable.id,
                invRows.map((r) => r.id),
              ),
            );
        }
        // caseRestorations + caseEvents cascade from cases.
        await db.delete(casesTable).where(eq(casesTable.id, caseId));
      }
      // Provider org must be removed before the shared afterAll deletes labOrgId
      // (organizations.id has restrict FK from cases.providerOrganizationId and
      // organizations.parentLabOrganizationId).
      await db.delete(organizations).where(eq(organizations.id, provOrgId));
    }
  }, 30000);

  // ── (k) Legacy (N/A-tooth) alloy row survives a re-sync without doubling ──
  //
  // Regression guard for the second alloy path: when a case has no PFM/FCM
  // restorations, addAlloyChargeToCase inserts a single alloy row with
  // toothNumber "N/A". buildGroupedSyncItems emits that row as a top-level
  // "Alloy" line (not a child sub-item). A second syncInvoiceFromRestorations
  // call must rebuild exactly ONE such line, not two.
  //
  // Flow:
  //   1. Create a canonical case with one non-PFM restoration (All-Ceramic).
  //   2. POST /api/cases/:id/alloy-charge → legacy path inserts N/A alloy row.
  //   3. Assert: 1 top-level "Alloy" invoice line, no alloy children.
  //   4. Call syncInvoiceFromRestorations a second time.
  //   5. Assert: still exactly 1 top-level "Alloy" line (not doubled).
  //
  it("(k) Legacy N/A-tooth alloy row survives a re-sync without doubling", async () => {
    const {
      db,
      organizations,
      cases: casesTable,
      caseRestorations,
      invoices: invoicesTable,
      invoiceLineItems,
    } = dbMod as any;

    const provOrgId = rid("provk");
    await db.insert(organizations).values([
      {
        id: provOrgId,
        type: "provider",
        name: `Legacy Alloy Test Provider ${provOrgId}`,
        parentLabOrganizationId: labOrgId,
      },
    ]);

    let caseId: string | null = null;
    try {
      // ── Step 1: create a canonical case ──────────────────────────────────
      const caseR = await request(appMod.default)
        .post("/api/cases")
        .set("Authorization", `Bearer ${mobileToken}`)
        .send({
          caseNumber: `LEGACY-ALLOY-${rid("CN")}`,
          labOrganizationId: labOrgId,
          providerOrganizationId: provOrgId,
          patientFirstName: "Legacy",
          patientLastName: "Alloy",
          doctorName: "Dr. LegacyAlloy",
          status: "received",
        });
      expect(caseR.status, JSON.stringify(caseR.body)).toBe(201);
      caseId = caseR.body.data.id as string;

      // ── Step 2: add a non-PFM restoration ────────────────────────────────
      const rCeramic = await request(appMod.default)
        .post(`/api/cases/${caseId}/restorations`)
        .set("Authorization", `Bearer ${mobileToken}`)
        .send({ toothNumber: "8", restorationType: "Full Crown", material: "Emax" });
      expect(rCeramic.status, JSON.stringify(rCeramic.body)).toBe(201);

      // ── Step 3: insert the legacy N/A alloy restoration row directly ────────
      // The manual reminder endpoint requires a configured alloy price
      // (requirePriced: true). We insert the row directly to simulate the
      // legacy path being triggered once (e.g. by a lab that already had alloy
      // pricing configured), so the test focuses on the re-sync idempotency.
      await db.insert(caseRestorations).values({
        caseId,
        toothNumber: "N/A",
        restorationType: "Alloy",
        material: null,
        shade: null,
        notes: null,
        quantity: 1,
        unitPrice: "25.00",
        priceSource: null,
        priceSourceId: null,
        priceSourceName: null,
        priceKey: "alloy",
      });

      // Confirm exactly 1 alloy restoration row with toothNumber "N/A".
      const alloyRestorations = await db
        .select()
        .from(caseRestorations)
        .where(
          and(
            eq(caseRestorations.caseId, caseId),
            eq(caseRestorations.restorationType, "Alloy"),
          ),
        );
      expect(alloyRestorations, "exactly 1 N/A alloy restoration row").toHaveLength(1);
      expect((alloyRestorations[0] as any).toothNumber).toBe("N/A");

      // Perform the first sync so the invoice reflects the N/A alloy row.
      const { syncInvoiceFromRestorations: syncFn } = await import(
        "../lib/invoice-sync.js"
      );
      await syncFn({ caseId, actorUserId: null });

      // ── Step 4: verify initial invoice line structure ─────────────────────
      let invoice: any;
      for (let i = 0; i < 30; i++) {
        await new Promise((res) => setTimeout(res, 100));
        [invoice] = await db
          .select()
          .from(invoicesTable)
          .where(eq(invoicesTable.caseId, caseId));
        if (invoice) break;
      }
      expect(invoice, "invoice must exist after alloy charge").toBeDefined();

      const linesBefore = await db
        .select()
        .from(invoiceLineItems)
        .where(eq(invoiceLineItems.invoiceId, invoice.id));

      const alloyTopLevelBefore = linesBefore.filter(
        (l: any) => l.parentLineItemId === null && l.description === "Alloy",
      );
      const alloyChildrenBefore = linesBefore.filter(
        (l: any) => l.parentLineItemId !== null && l.description === "Alloy",
      );

      expect(
        alloyTopLevelBefore,
        "exactly 1 top-level Alloy line before re-sync",
      ).toHaveLength(1);
      expect(
        alloyChildrenBefore,
        "no Alloy child sub-items (legacy path)",
      ).toHaveLength(0);

      // ── Step 5: re-sync (simulates a case PATCH or restoration edit) ────────
      await syncFn({ caseId, actorUserId: null });

      // ── Step 6: assert no doubling ────────────────────────────────────────
      const linesAfter = await db
        .select()
        .from(invoiceLineItems)
        .where(eq(invoiceLineItems.invoiceId, invoice.id));

      const alloyTopLevelAfter = linesAfter.filter(
        (l: any) => l.parentLineItemId === null && l.description === "Alloy",
      );
      const alloyChildrenAfter = linesAfter.filter(
        (l: any) => l.parentLineItemId !== null && l.description === "Alloy",
      );

      expect(
        alloyTopLevelAfter,
        "still exactly 1 top-level Alloy line after re-sync (not doubled)",
      ).toHaveLength(1);
      expect(
        alloyChildrenAfter,
        "no Alloy child sub-items after re-sync (legacy path)",
      ).toHaveLength(0);
    } finally {
      if (caseId) {
        const invRows: Array<{ id: string }> = await db
          .select({ id: invoicesTable.id })
          .from(invoicesTable)
          .where(eq(invoicesTable.caseId, caseId));
        if (invRows.length) {
          await db
            .delete(invoiceLineItems)
            .where(
              inArray(
                invoiceLineItems.invoiceId,
                invRows.map((r) => r.id),
              ),
            );
          await db
            .delete(invoicesTable)
            .where(
              inArray(
                invoicesTable.id,
                invRows.map((r) => r.id),
              ),
            );
        }
        await db.delete(casesTable).where(eq(casesTable.id, caseId));
      }
      await db.delete(organizations).where(eq(organizations.id, provOrgId));
    }
  }, 30000);

  // ── (h) Same Case ID visible across platforms ───────────────────────────
  //
  // Regression guard for the "Same Case ID must be visible across platforms"
  // invariant. A client-generated case ID posted via the mobile sync endpoint
  // must appear UNCHANGED in GET /api/cases — the server must NOT replace it
  // with a server-generated ID. This is what lets desktop/web correlate cases
  // created on mobile without a reconciliation step.
  //
  it("(h) Client-generated case ID is preserved in GET /api/cases (same-ID invariant)", async () => {
    const clientGeneratedId = rid("client");
    const caseBlob = {
      id: clientGeneratedId,
      caseNumber: "26-SAMEID",
      patientName: "Eva SameId",
      doctorName: "Dr. SameId",
      status: "INTAKE",
      affiliationKey: `org:${labOrgId}`,
    };

    const post = await request(appMod.default)
      .post("/api/legacy/cases")
      .set("Authorization", `Bearer ${mobileToken}`)
      .send({
        id: clientGeneratedId,
        ownerId: mobileUserId,
        caseData: JSON.stringify(caseBlob),
      });
    expect(post.status).toBe(200);

    const list = await request(appMod.default)
      .get("/api/cases")
      .set("Authorization", `Bearer ${mobileToken}`);

    expect(list.status).toBe(200);
    const cases: any[] = list.body.data ?? list.body;
    const found = cases.find((c: any) => c.id === clientGeneratedId);
    expect(
      found,
      "case must appear in GET /api/cases with the client-generated ID (not a server replacement)",
    ).toBeDefined();
    expect(found.id).toBe(clientGeneratedId);
    expect(found.caseNumber).toBe("26-SAMEID");
  });

  it("serializes invoice PATCH and restoration sync at the real invoice lock boundary", async () => {
    const {
      db,
      cases: casesTable,
      organizations,
      invoices: invoicesTable,
      invoiceLineItems,
      caseRestorations,
    } = dbMod as any;
    const providerId = rid("lock_provider");
    const caseId = rid("lock_case");
    const invoiceId = rid("lock_invoice");
    const restorationId = rid("lock_restoration");
    const lineItemId = rid("lock_line");
    const holder = await (dbMod as any).pool.connect();
    const blockerPid = Number((await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
    const started: Promise<unknown>[] = [];
    let invoiceCreated = false;
    try {
      await db.insert(organizations).values({
        id: providerId,
        type: "provider",
        name: `Lock Provider ${providerId}`,
        parentLabOrganizationId: labOrgId,
      });
      await db.insert(casesTable).values({
        id: caseId,
        caseNumber: `LOCK-${caseId}`,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerId,
        patientFirstName: "Lock",
        patientLastName: "Boundary",
        doctorName: "Dr. Boundary",
        status: "received",
        createdByUserId: mobileUserId,
      });
      await db.insert(caseRestorations).values({
        id: restorationId,
        caseId,
        toothNumber: "14",
        restorationType: "Crown",
        material: "Zirconia",
        quantity: 1,
        unitPrice: "100.00",
      });
      await db.insert(invoicesTable).values({
        id: invoiceId,
        invoiceNumber: `LOCK-${invoiceId}`,
        caseId,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerId,
        status: "open",
        subtotal: "100.00",
        total: "100.00",
        balanceDue: "100.00",
        createdByUserId: mobileUserId,
      });
      invoiceCreated = true;
      await db.insert(invoiceLineItems).values({
        id: lineItemId,
        invoiceId,
        caseRestorationId: restorationId,
        sourceType: "restoration",
        sourceKey: `restoration:${restorationId}`,
        sourceRestorationIdsJson: [restorationId],
        toothNumber: 14,
        toothLabel: "#14",
        description: "Zirconia Crown",
        quantity: 1,
        unitPrice: "100.00",
        lineTotal: "100.00",
      });

      // Hold the exact advisory key used by sync and PATCH.  The operations
      // are started while the lock is held, then released together; this is a
      // deterministic boundary test (not a scheduler/timing test).
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtext($1))", [invoiceId]);
      await holder.query("SELECT id FROM invoices WHERE id = $1 FOR UPDATE", [invoiceId]);
      const { syncInvoiceFromRestorations } = await import("../lib/invoice-sync.js");
      const sync = syncInvoiceFromRestorations({ caseId, actorUserId: mobileUserId });
      const patch = Promise.resolve(request(appMod.default)
        .patch(`/api/invoices/${invoiceId}`)
        .set("Authorization", `Bearer ${mobileToken}`)
        .send({
          items: [{
            id: lineItemId,
            description: "Zirconia Crown",
            quantity: 1,
            unitPrice: 125,
            toothNumber: 14,
            sortOrder: 0,
          }],
        }));
      started.push(sync, patch);
      await waitForBlockingEvents(blockerPid, ["advisory", "advisory"]);
      await holder.query("COMMIT");
      const [syncResult, patchResult] = await Promise.all([sync, patch]);
      expect(syncResult).toBe(invoiceId);
      expect(patchResult.status).toBe(200);

      const [finalInvoice] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, invoiceId));
      expect(finalInvoice).toMatchObject({
        status: "open",
        total: "125.00",
        balanceDue: "125.00",
      });
      const finalLines = await db
        .select()
        .from(invoiceLineItems)
        .where(eq(invoiceLineItems.invoiceId, invoiceId));
      expect(finalLines).toHaveLength(1);
      expect(finalLines[0]).toMatchObject({
        caseRestorationId: restorationId,
        sourceType: "restoration",
        unitPrice: "125.00",
        lineTotal: "125.00",
      });
    } finally {
      try {
        await holder.query("ROLLBACK");
      } catch {
        // The connection may already have been released after a failed setup.
      }
      await Promise.allSettled(started);
      holder.release();
      if (invoiceCreated) {
        await db.delete(invoicesTable).where(eq(invoicesTable.id, invoiceId));
        await db.delete(caseRestorations).where(eq(caseRestorations.caseId, caseId));
        await db.delete(casesTable).where(eq(casesTable.id, caseId));
      }
      await db.delete(organizations).where(eq(organizations.id, providerId));
    }
  }, 30000);
});
