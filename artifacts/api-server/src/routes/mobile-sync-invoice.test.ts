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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
      doctorName: "Dr. Smith",
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
    expect(parsed.doctorName).toBe("Dr. Smith");
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
});
