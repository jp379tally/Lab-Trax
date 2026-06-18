/**
 * Integration tests for case listing, search, and tenant isolation (regression guard).
 *
 * Skipped when DATABASE_URL is not configured.  All inserted rows are removed
 * in afterAll so the suite is safe to run against a shared dev DB.
 *
 * Coverage:
 *  - GET /api/cases — returns only cases belonging to the authenticated user's lab
 *    (tenant isolation: cases from a different lab are not visible)
 *  - GET /api/cases — returns 401 when unauthenticated
 *  - GET /api/cases?search=<term> — REVEALING GAP: filter by patient/doctor name is
 *    not yet implemented; test documents the expected invariant so the gap is visible
 *  - GET /api/cases?status=Active — REVEALING GAP: status filter not yet implemented
 *  - GET /api/cases?barcode=<code> — REVEALING GAP: barcode filter not yet implemented
 *  - GET /api/cases/quick-search — filters by patient first/last name and case number prefix;
 *    returns empty array for short/no-match queries; non-member gets 403;
 *    missing labOrganizationId returns 400; cross-lab cases are not returned
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";
import request from "supertest";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

const TEST_MEDIA_DIR = path.join(os.tmpdir(), "labtrax-test-media-search");

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(require("os").tmpdir(), "labtrax-test-media-search"),
  extractMediaFileName: () => null,
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("Cases search and tenant isolation (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let auth: typeof import("../lib/auth.js");
  let casesMod: typeof import("./cases.js");

  const labOrgId = rid("lab");
  const otherLabOrgId = rid("lab2");
  const providerOrgId = rid("prov");
  const otherProviderOrgId = rid("prov2");
  const labAdminUserId = rid("uadmin");
  const outsiderUserId = rid("uout");

  const tokens = { admin: "", outsider: "" };

  async function makeSession(userId: string): Promise<string> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const token = auth.signAccessToken(userId, sessionId);
    const hash = createHash("sha256").update(token).digest("hex");
    await db.insert(userSessions).values({ id: sessionId, userId, tokenHash: hash, expiresAt });
    return token;
  }

  async function insertCase(opts: {
    caseNumber: string;
    labId?: string;
    practiceId?: string;
    patientFirst?: string;
    patientLast?: string;
    doctorName?: string;
    status?: string;
    panBarcode?: string;
  }) {
    const { db, cases } = dbMod as any;
    const id = rid("c");
    await db.insert(cases).values({
      id,
      caseNumber: opts.caseNumber,
      labOrganizationId: opts.labId ?? labOrgId,
      providerOrganizationId: opts.practiceId ?? providerOrgId,
      patientFirstName: opts.patientFirst ?? "Pat",
      patientLastName: opts.patientLast ?? "Test",
      doctorName: opts.doctorName ?? "Dr. Test",
      status: opts.status ?? "received",
      createdByUserId: labAdminUserId,
      ...(opts.panBarcode ? { casePanBarcode: opts.panBarcode } : {}),
    });
    return id;
  }

  // Legacy mobile cases live in `lab_cases` and store their barcode inside the
  // `case_data` JSON blob under `assignedBarcode` (surfaced as `casePanBarcode`
  // in the unified list shape).
  const legacyCaseIds: string[] = [];
  async function insertLegacyCase(opts: {
    assignedBarcode: string;
    labId?: string;
    patientName?: string;
    caseNumber?: string;
    status?: string;
  }) {
    const { db, labCases } = dbMod as any;
    const id = rid("lc");
    const caseData = JSON.stringify({
      patientName: opts.patientName ?? "Bera Brown",
      caseNumber: opts.caseNumber ?? "26-2",
      doctorName: "Dr. Mobile",
      status: opts.status ?? "DESIGN",
      assignedBarcode: opts.assignedBarcode,
      createdAt: Date.now(),
    });
    await db.insert(labCases).values({
      id,
      organizationId: opts.labId ?? labOrgId,
      ownerId: labAdminUserId,
      caseData,
    });
    legacyCaseIds.push(id);
    return id;
  }

  beforeAll(async () => {
    fs.mkdirSync(TEST_MEDIA_DIR, { recursive: true });
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-case-search";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    auth = await import("../lib/auth.js");
    casesMod = await import("./cases.js");

    const { db, organizations, users, organizationMemberships } = dbMod as any;

    await db.insert(users).values([
      { id: labAdminUserId, username: `adm_${labAdminUserId}`, password: "testpass" },
      { id: outsiderUserId, username: `out_${outsiderUserId}`, password: "testpass" },
    ]);

    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: "Search Test Lab" },
      { id: otherLabOrgId, type: "lab", name: "Other Lab" },
      { id: providerOrgId, type: "provider", name: "Test Practice", parentLabOrganizationId: labOrgId },
      { id: otherProviderOrgId, type: "provider", name: "Other Practice", parentLabOrganizationId: otherLabOrgId },
    ]);

    await db.insert(organizationMemberships).values([
      { id: rid("m"), labId: labOrgId, userId: labAdminUserId, role: "admin", status: "active" },
    ]);

    tokens.admin = await makeSession(labAdminUserId);
    tokens.outsider = await makeSession(outsiderUserId);
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const {
      db,
      organizations,
      users,
      cases,
      labCases,
      organizationMemberships,
      userSessions,
      auditLogs,
      invoices,
    } = dbMod as any;
    if (legacyCaseIds.length) {
      await db.delete(labCases).where(inArray(labCases.id, legacyCaseIds));
    }
    // invoices.labOrganizationId is onDelete:restrict — must delete before orgs.
    await db.delete(auditLogs).where(
      inArray(auditLogs.organizationId, [labOrgId, otherLabOrgId])
    );
    await db.delete(invoices).where(
      inArray(invoices.labOrganizationId, [labOrgId, otherLabOrgId, providerOrgId, otherProviderOrgId])
    );
    await db.delete(cases).where(eq(cases.labOrganizationId, labOrgId));
    await db.delete(cases).where(eq(cases.labOrganizationId, otherLabOrgId));
    await db.delete(organizationMemberships).where(
      inArray(organizationMemberships.userId, [labAdminUserId, outsiderUserId])
    );
    await db.delete(userSessions).where(
      inArray(userSessions.userId, [labAdminUserId, outsiderUserId])
    );
    await db.delete(organizations).where(
      inArray(organizations.id, [labOrgId, otherLabOrgId, providerOrgId, otherProviderOrgId])
    );
    await db.delete(users).where(
      inArray(users.id, [labAdminUserId, outsiderUserId])
    );
  });

  // ── Tenant isolation ──────────────────────────────────────────────────────

  it("GET /api/cases: returns only cases belonging to the user's lab", async () => {
    const myCase = await insertCase({ caseNumber: rid("MY"), labId: labOrgId });
    const otherCase = await insertCase({ caseNumber: rid("OTH"), labId: otherLabOrgId, practiceId: otherProviderOrgId });

    const r = await request(appMod.default)
      .get("/api/cases")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .query({ organizationId: labOrgId });

    expect(r.status).toBe(200);
    const ids = r.body.data.map((c: any) => c.id);
    expect(ids).toContain(myCase);
    expect(ids).not.toContain(otherCase);

    const { db, cases } = dbMod as any;
    await db.delete(cases).where(inArray(cases.id, [myCase, otherCase]));
  });

  it("GET /api/cases: returns 401 when unauthenticated", async () => {
    const r = await request(appMod.default).get("/api/cases");
    expect(r.status).toBe(401);
  });

  // ── Search filter (gap: not yet implemented) ──────────────────────────────
  //
  // The following three tests call GET /api/cases with search-related query
  // params that the current implementation does not yet support. They assert
  // the EXPECTED filtering behaviour so that regressions and implementation
  // gaps are visible. They will FAIL until the features are added.

  it("GET /api/cases?search=<name>: returns only cases matching patient/doctor name (gap: filter not implemented)", async () => {
    const aliceCase = await insertCase({
      caseNumber: rid("SRC"),
      patientFirst: "UniqueAliceName",
      patientLast: "Zoltan",
    });
    const bobCase = await insertCase({
      caseNumber: rid("SRC"),
      patientFirst: "UnrelatedBobXYZ",
      patientLast: "Hoffman",
    });

    const r = await request(appMod.default)
      .get("/api/cases")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .query({ organizationId: labOrgId, search: "UniqueAliceName" });

    expect(r.status).toBe(200);
    const ids = r.body.data.map((c: any) => c.id);
    expect(ids).toContain(aliceCase);
    // FAILING: GET /api/cases ignores ?search — bobCase is also returned.
    expect(ids).not.toContain(bobCase);

    const { db, cases } = dbMod as any;
    await db.delete(cases).where(inArray(cases.id, [aliceCase, bobCase]));
  });

  it("GET /api/cases?status=active: returns only cases with that status (gap: filter not implemented)", async () => {
    const activeCase = await insertCase({
      caseNumber: rid("STS"),
      status: "active",
    });
    const receivedCase = await insertCase({
      caseNumber: rid("STS"),
      status: "received",
    });

    const r = await request(appMod.default)
      .get("/api/cases")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .query({ organizationId: labOrgId, status: "active" });

    expect(r.status).toBe(200);
    const ids = r.body.data.map((c: any) => c.id);
    expect(ids).toContain(activeCase);
    // FAILING: GET /api/cases ignores ?status — receivedCase is also returned.
    expect(ids).not.toContain(receivedCase);

    const { db, cases } = dbMod as any;
    await db.delete(cases).where(inArray(cases.id, [activeCase, receivedCase]));
  });

  it("GET /api/cases?search=<barcode>: returns only cases whose pan barcode contains the search term", async () => {
    const uniqueBarcode = `PB${randomBytes(5).toString("hex").toUpperCase()}`;
    // Search with a partial (middle) substring of the barcode to verify
    // contains / LIKE semantics rather than exact-match behaviour.
    const partialSearch = uniqueBarcode.slice(2, 8).toLowerCase();
    const barcodeCase = await insertCase({
      caseNumber: rid("PBS"),
      patientFirst: "Pat",
      patientLast: "Smith",
      panBarcode: uniqueBarcode,
    });
    const decoyCase = await insertCase({
      caseNumber: rid("PBS"),
      patientFirst: "Other",
      patientLast: "Person",
    });

    const r = await request(appMod.default)
      .get("/api/cases")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .query({ organizationId: labOrgId, search: partialSearch });

    expect(r.status).toBe(200);
    const ids = r.body.data.map((c: any) => c.id);
    expect(ids).toContain(barcodeCase);
    expect(ids).not.toContain(decoyCase);

    const { db, cases } = dbMod as any;
    await db.delete(cases).where(inArray(cases.id, [barcodeCase, decoyCase]));
  });

  it("GET /api/cases?barcode=<code>: returns only the case with that pan barcode (gap: filter not implemented)", async () => {
    const barcode = `BAR${randomBytes(4).toString("hex").toUpperCase()}`;
    const barcodeCase = await insertCase({
      caseNumber: rid("BRC"),
      panBarcode: barcode,
    });
    const decoyCase = await insertCase({ caseNumber: rid("BRC") });

    const r = await request(appMod.default)
      .get("/api/cases")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .query({ organizationId: labOrgId, barcode });

    expect(r.status).toBe(200);
    const ids = r.body.data.map((c: any) => c.id);
    expect(ids).toContain(barcodeCase);
    // FAILING: GET /api/cases ignores ?barcode — decoyCase is also returned.
    expect(ids).not.toContain(decoyCase);

    const { db, cases } = dbMod as any;
    await db.delete(cases).where(inArray(cases.id, [barcodeCase, decoyCase]));
  });

  // ── barcode lookup ────────────────────────────────────────────────────────

  it("GET /api/cases/barcode/:code: returns the matching case (happy path)", async () => {
    const barcode = `BAR${randomBytes(4).toString("hex").toUpperCase()}`;
    const caseId = await insertCase({ caseNumber: rid("BCD"), panBarcode: barcode });

    const r = await request(appMod.default)
      .get(`/api/cases/barcode/${barcode}`)
      .set("Authorization", `Bearer ${tokens.admin}`)
      .query({ labOrganizationId: labOrgId });

    expect(r.status).toBe(200);
    expect(r.body.data.case.id).toBe(caseId);
    expect(r.body.data.case.casePanBarcode).toBe(barcode);

    const { db, cases } = dbMod as any;
    await db.delete(cases).where(eq(cases.id, caseId));
  });

  it("GET /api/cases/barcode/:code: finds a legacy mobile case by its assignedBarcode", async () => {
    // Regression: a mobile-created case (lab_cases) stores its barcode in
    // case_data.assignedBarcode. The lookup route previously only checked the
    // canonical `cases` table, so scanning/entering such a barcode 404'd even
    // though the case is visible in the list.
    const barcode = "0002";
    const legacyId = await insertLegacyCase({
      assignedBarcode: barcode,
      patientName: "Bera Brown",
      caseNumber: "26-2",
      status: "DESIGN",
    });

    const r = await request(appMod.default)
      .get(`/api/cases/barcode/${barcode}`)
      .set("Authorization", `Bearer ${tokens.admin}`)
      .query({ labOrganizationId: labOrgId });

    expect(r.status).toBe(200);
    expect(r.body.data.case.id).toBe(legacyId);
    expect(r.body.data.case.casePanBarcode).toBe(barcode);
    expect(r.body.data.case.patientFirstName).toBe("Bera");
    expect(r.body.data.case.patientLastName).toBe("Brown");
    expect(r.body.data.case.status).toBe("in_design");
  });

  it("GET /api/cases/barcode/:code: does not return a legacy case from a different lab", async () => {
    const barcode = `XLLEG${randomBytes(4).toString("hex").toUpperCase()}`;
    await insertLegacyCase({ assignedBarcode: barcode, labId: otherLabOrgId });

    const r = await request(appMod.default)
      .get(`/api/cases/barcode/${barcode}`)
      .set("Authorization", `Bearer ${tokens.admin}`)
      .query({ labOrganizationId: labOrgId });

    expect(r.status).toBe(404);
  });

  it("GET /api/cases/barcode/:code: returns 404 when no case has that barcode", async () => {
    const ghost = `GHOST${randomBytes(4).toString("hex").toUpperCase()}`;

    const r = await request(appMod.default)
      .get(`/api/cases/barcode/${ghost}`)
      .set("Authorization", `Bearer ${tokens.admin}`)
      .query({ labOrganizationId: labOrgId });

    expect(r.status).toBe(404);
  });

  it("GET /api/cases/barcode/:code: does not return a case from a different lab", async () => {
    const barcode = `XLAB${randomBytes(4).toString("hex").toUpperCase()}`;
    const otherCaseId = await insertCase({
      caseNumber: rid("XLABB"),
      labId: otherLabOrgId,
      practiceId: otherProviderOrgId,
      panBarcode: barcode,
    });

    const r = await request(appMod.default)
      .get(`/api/cases/barcode/${barcode}`)
      .set("Authorization", `Bearer ${tokens.admin}`)
      .query({ labOrganizationId: labOrgId });

    expect(r.status).toBe(404);

    const { db, cases } = dbMod as any;
    await db.delete(cases).where(eq(cases.id, otherCaseId));
  });

  it("GET /api/cases/barcode/:code: non-member gets 403", async () => {
    const barcode = `NMB${randomBytes(4).toString("hex").toUpperCase()}`;
    const caseId = await insertCase({ caseNumber: rid("NMB"), panBarcode: barcode });

    const r = await request(appMod.default)
      .get(`/api/cases/barcode/${barcode}`)
      .set("Authorization", `Bearer ${tokens.outsider}`)
      .query({ labOrganizationId: labOrgId });

    expect(r.status).toBe(403);

    const { db, cases } = dbMod as any;
    await db.delete(cases).where(eq(cases.id, caseId));
  });

  it("GET /api/cases/barcode/:code: missing labOrganizationId returns 400", async () => {
    const r = await request(appMod.default)
      .get("/api/cases/barcode/SOMEBARCODE")
      .set("Authorization", `Bearer ${tokens.admin}`);

    expect(r.status).toBe(400);
  });

  // ── quick-search ──────────────────────────────────────────────────────────

  it("GET /api/cases/quick-search: filters by patient last name prefix", async () => {
    const caseId = await insertCase({
      caseNumber: rid("QS"),
      patientFirst: "Alice",
      patientLast: "Zimmermann",
    });

    const r = await request(appMod.default)
      .get("/api/cases/quick-search")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .query({ labOrganizationId: labOrgId, q: "Zi" });

    expect(r.status).toBe(200);
    const ids = r.body.data.cases.map((c: any) => c.id);
    expect(ids).toContain(caseId);

    const { db, cases } = dbMod as any;
    await db.delete(cases).where(eq(cases.id, caseId));
  });

  it("GET /api/cases/quick-search: filters by patient first name prefix", async () => {
    const caseId = await insertCase({
      caseNumber: rid("QS"),
      patientFirst: "Queenie",
      patientLast: "Brown",
    });

    const r = await request(appMod.default)
      .get("/api/cases/quick-search")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .query({ labOrganizationId: labOrgId, q: "Qu" });

    expect(r.status).toBe(200);
    const ids = r.body.data.cases.map((c: any) => c.id);
    expect(ids).toContain(caseId);

    const { db, cases } = dbMod as any;
    await db.delete(cases).where(eq(cases.id, caseId));
  });

  it("GET /api/cases/quick-search: filters by case number prefix (barcode locate)", async () => {
    const barcodePrefix = `BRC${randomBytes(3).toString("hex")}`;
    const caseId = await insertCase({ caseNumber: `${barcodePrefix}-001` });

    const r = await request(appMod.default)
      .get("/api/cases/quick-search")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .query({ labOrganizationId: labOrgId, q: barcodePrefix.toLowerCase() });

    expect(r.status).toBe(200);
    const ids = r.body.data.cases.map((c: any) => c.id);
    expect(ids).toContain(caseId);

    const { db, cases } = dbMod as any;
    await db.delete(cases).where(eq(cases.id, caseId));
  });

  it("GET /api/cases/quick-search: returns empty array when no case matches", async () => {
    const r = await request(appMod.default)
      .get("/api/cases/quick-search")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .query({ labOrganizationId: labOrgId, q: "ZZZNOMATCH" });

    expect(r.status).toBe(200);
    expect(r.body.data.cases).toEqual([]);
  });

  it("GET /api/cases/quick-search: returns empty array when query is shorter than 2 chars", async () => {
    const r = await request(appMod.default)
      .get("/api/cases/quick-search")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .query({ labOrganizationId: labOrgId, q: "A" });

    expect(r.status).toBe(200);
    expect(r.body.data.cases).toEqual([]);
  });

  it("GET /api/cases/quick-search: non-member gets 403", async () => {
    const r = await request(appMod.default)
      .get("/api/cases/quick-search")
      .set("Authorization", `Bearer ${tokens.outsider}`)
      .query({ labOrganizationId: labOrgId, q: "Te" });

    expect(r.status).toBe(403);
  });

  it("GET /api/cases/quick-search: missing labOrganizationId returns 400", async () => {
    const r = await request(appMod.default)
      .get("/api/cases/quick-search")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .query({ q: "Te" });

    expect(r.status).toBe(400);
  });

  it("GET /api/cases/quick-search: a case from a different lab is not returned", async () => {
    const otherCase = await insertCase({
      caseNumber: `XLAB${rid("c")}`,
      labId: otherLabOrgId,
      practiceId: otherProviderOrgId,
      patientFirst: "CrossTenantXxx",
      patientLast: "Tenant",
    });

    const r = await request(appMod.default)
      .get("/api/cases/quick-search")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .query({ labOrganizationId: labOrgId, q: "Cr" });

    expect(r.status).toBe(200);
    const ids = r.body.data.cases.map((c: any) => c.id);
    expect(ids).not.toContain(otherCase);

    const { db, cases } = dbMod as any;
    await db.delete(cases).where(eq(cases.id, otherCase));
  });

  // ── Barcode string-fidelity and uniqueness (canonical barcode) ────────────

  it("POST /api/cases: stores leading-zero barcode '0001' verbatim as the string '0001'", async () => {
    const caseNumber = rid("BZ");
    const r = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({
        caseNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Zero",
        patientLastName: "Leading",
        doctorName: "Dr. Zero",
        casePanBarcode: "0001",
      });

    expect(r.status).toBe(201);
    const created = r.body.data?.case ?? r.body.data;
    expect(created.casePanBarcode).toBe("0001");

    // Verify the DB stores the string "0001", not the number 1.
    const { db, cases } = dbMod as any;
    const row = await db.query.cases.findFirst({
      where: eq(cases.id, created.id),
      columns: { casePanBarcode: true },
    });
    expect(row?.casePanBarcode).toBe("0001");
    expect(row?.casePanBarcode).not.toBe("1");

    await db.delete(cases).where(eq(cases.id, created.id));
  });

  it("GET /api/cases/barcode/0001: resolves to the case whose barcode is '0001'", async () => {
    const caseId = await insertCase({ caseNumber: rid("BZ2"), panBarcode: "0001" });

    const r = await request(appMod.default)
      .get("/api/cases/barcode/0001")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .query({ labOrganizationId: labOrgId });

    expect(r.status).toBe(200);
    expect(r.body.data.case.id).toBe(caseId);
    expect(r.body.data.case.casePanBarcode).toBe("0001");

    const { db, cases } = dbMod as any;
    await db.delete(cases).where(eq(cases.id, caseId));
  });

  it("GET /api/cases/barcode/1: does NOT match a case whose barcode is '0001' (exact-string match)", async () => {
    const caseId = await insertCase({ caseNumber: rid("BZ3"), panBarcode: "0001" });

    const r = await request(appMod.default)
      .get("/api/cases/barcode/1")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .query({ labOrganizationId: labOrgId });

    expect(r.status).toBe(404);

    const { db, cases } = dbMod as any;
    await db.delete(cases).where(eq(cases.id, caseId));
  });

  it("PATCH /api/cases/:id: rejects duplicate barcode assignment to a second active case (409)", async () => {
    const sharedBarcode = `DUP${randomBytes(4).toString("hex").toUpperCase()}`;
    const case1Id = await insertCase({ caseNumber: rid("DUP"), panBarcode: sharedBarcode });
    const case2Id = await insertCase({ caseNumber: rid("DUP") });

    const r = await request(appMod.default)
      .patch(`/api/cases/${case2Id}`)
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({ casePanBarcode: sharedBarcode });

    expect(r.status).toBe(409);
    expect(r.body.error ?? r.body.message ?? "").toMatch(/already assigned/i);

    const { db, cases } = dbMod as any;
    await db.delete(cases).where(inArray(cases.id, [case1Id, case2Id]));
  });

  it("PATCH /api/cases/:id: barcodes are strictly unique — allowDuplicateBarcode no longer overrides (409)", async () => {
    const sharedBarcode = `OVR${randomBytes(4).toString("hex").toUpperCase()}`;
    const case1Id = await insertCase({ caseNumber: rid("OVR"), panBarcode: sharedBarcode });
    const case2Id = await insertCase({ caseNumber: rid("OVR") });

    // The admin force-duplicate override was removed in favor of a hard
    // per-lab unique index. The flag is ignored and the duplicate is rejected.
    const r = await request(appMod.default)
      .patch(`/api/cases/${case2Id}`)
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({ casePanBarcode: sharedBarcode, allowDuplicateBarcode: true });

    expect(r.status).toBe(409);
    expect(r.body.error ?? r.body.message ?? "").toMatch(/already assigned/i);

    const { db, cases } = dbMod as any;
    await db.delete(cases).where(inArray(cases.id, [case1Id, case2Id]));
  });

  it("POST /api/cases: rejects duplicate barcode at creation (409)", async () => {
    const sharedBarcode = `CDUP${randomBytes(4).toString("hex").toUpperCase()}`;
    const existingId = await insertCase({ caseNumber: rid("CDUP"), panBarcode: sharedBarcode });

    const r = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({
        caseNumber: rid("CDUP2"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "New",
        patientLastName: "Case",
        doctorName: "Dr. New",
        casePanBarcode: sharedBarcode,
      });

    expect(r.status).toBe(409);
    expect(r.body.error ?? r.body.message ?? "").toMatch(/already assigned/i);

    const { db, cases } = dbMod as any;
    await db.delete(cases).where(eq(cases.id, existingId));
  });

  it("PATCH /api/cases/:id: allows reusing a barcode held by a completed case (not a duplicate)", async () => {
    const sharedBarcode = `COMP${randomBytes(4).toString("hex").toUpperCase()}`;
    // Insert an existing case, then mark it complete (barcode should be released).
    const completedId = await insertCase({ caseNumber: rid("COMP"), panBarcode: sharedBarcode });
    const { db, cases } = dbMod as any;
    await db.update(cases).set({ status: "complete", casePanBarcode: sharedBarcode }).where(eq(cases.id, completedId));

    // New active case should be able to take that barcode without conflict.
    const activeId = await insertCase({ caseNumber: rid("COMP2") });
    const r = await request(appMod.default)
      .patch(`/api/cases/${activeId}`)
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({ casePanBarcode: sharedBarcode });

    expect(r.status).toBe(200);
    expect(r.body.data?.casePanBarcode).toBe(sharedBarcode);

    await db.delete(cases).where(inArray(cases.id, [completedId, activeId]));
  });

  it("POST /api/cases: allows creating a case with a barcode held by a completed case", async () => {
    const sharedBarcode = `CCOMP${randomBytes(4).toString("hex").toUpperCase()}`;
    const completedId = await insertCase({ caseNumber: rid("CCOMP"), panBarcode: sharedBarcode });
    const { db, cases } = dbMod as any;
    await db.update(cases).set({ status: "complete", casePanBarcode: sharedBarcode }).where(eq(cases.id, completedId));

    const r = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({
        caseNumber: rid("CCOMP2"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Re",
        patientLastName: "Use",
        doctorName: "Dr. Reuse",
        casePanBarcode: sharedBarcode,
      });

    expect(r.status).toBe(201);
    const created = r.body.data?.case ?? r.body.data;
    expect(created.casePanBarcode).toBe(sharedBarcode);

    await db.delete(cases).where(inArray(cases.id, [completedId, created.id]));
  });

  // ── rethrowBarcodeConflict unit tests ────────────────────────────────────
  //
  // These tests exercise the function that translates PG 23505 errors from the
  // `cases_barcode_unique_per_lab` partial index into 409 responses. They are
  // separated from the concurrent-race integration tests so that a regression
  // in the constraint name or error code is caught directly, independently of
  // timing.

  it("rethrowBarcodeConflict: translates PG 23505 + cases_barcode_unique_per_lab into HttpError(409) — direct pg error", () => {
    // Direct pg DatabaseError shape (code + constraint on the error itself).
    const pgError = Object.assign(new Error("unique violation"), {
      code: "23505",
      constraint: "cases_barcode_unique_per_lab",
    });

    expect(() => casesMod.rethrowBarcodeConflict(pgError, "TESTBAR")).toThrow(
      expect.objectContaining({ statusCode: 409 })
    );
    expect(() => casesMod.rethrowBarcodeConflict(pgError, "TESTBAR")).toThrow(
      /already assigned/i
    );
  });

  it("rethrowBarcodeConflict: translates PG 23505 + cases_barcode_unique_per_lab into HttpError(409) — Drizzle-wrapped error", () => {
    // Drizzle ORM wraps the raw pg error in a DrizzleQueryError; the pg fields
    // live on err.cause.  This is the shape actually thrown in production.
    const cause = Object.assign(new Error("unique violation"), {
      code: "23505",
      constraint: "cases_barcode_unique_per_lab",
    });
    const drizzleError = Object.assign(new Error("DrizzleQueryError wrapper"), {
      cause,
    });

    expect(() => casesMod.rethrowBarcodeConflict(drizzleError, "TESTBAR")).toThrow(
      expect.objectContaining({ statusCode: 409 })
    );
    expect(() => casesMod.rethrowBarcodeConflict(drizzleError, "TESTBAR")).toThrow(
      /already assigned/i
    );
  });

  it("rethrowBarcodeConflict: re-throws 23505 from a different constraint unchanged", () => {
    const otherConstraint = Object.assign(new Error("unique violation"), {
      code: "23505",
      constraint: "cases_case_number_unique",
    });

    expect(() => casesMod.rethrowBarcodeConflict(otherConstraint, "X")).toThrow(otherConstraint);
  });

  it("rethrowBarcodeConflict: re-throws non-23505 errors unchanged", () => {
    const networkError = new Error("connection reset");
    expect(() => casesMod.rethrowBarcodeConflict(networkError, "X")).toThrow(networkError);
  });

  // ── Concurrent-race integration tests ────────────────────────────────────
  //
  // These tests prove that the cases_barcode_unique_per_lab DB constraint (not
  // just the checkBarcodeUniqueness pre-check) is what prevents two concurrent
  // requests from both assigning the same barcode.
  //
  // Mechanism: _testBarcodeWriteHook is a test-only latch injected into
  // cases.ts that fires after checkBarcodeUniqueness passes but before the DB
  // write (UPDATE / INSERT). By holding both requests at the latch until both
  // have cleared the pre-check, we guarantee:
  //   - Neither request rejected the other via the pre-check (no case# in msg)
  //   - Both writes reach the DB at the same time
  //   - The DB constraint catches the loser
  //   - rethrowBarcodeConflict translates 23505 → 409
  //
  // If the unique index were removed:  both writes succeed → no 409 → fails.
  // If rethrowBarcodeConflict stopped matching the constraint:  loser → 500 → fails.
  // If the message comes from the pre-check instead of the constraint:
  //   message contains "case #" rather than "another active case" → fails.

  it("PATCH /api/cases/:id race: DB constraint catches the loser when both requests clear the pre-check simultaneously", async () => {
    const raceBarcode = `RACE${randomBytes(4).toString("hex").toUpperCase()}`;
    const case1Id = await insertCase({ caseNumber: rid("RC1") });
    const case2Id = await insertCase({ caseNumber: rid("RC2") });

    // Latch: both requests block here until both have cleared checkBarcodeUniqueness.
    let arrivals = 0;
    let releaseAll!: () => void;
    const gateOpen = new Promise<void>((r) => { releaseAll = r; });
    casesMod._testHooks.barcodeWriteHook = async () => {
      arrivals++;
      if (arrivals >= 2) releaseAll();
      await gateOpen;
    };

    try {
      const [r1, r2] = await Promise.all([
        request(appMod.default)
          .patch(`/api/cases/${case1Id}`)
          .set("Authorization", `Bearer ${tokens.admin}`)
          .send({ casePanBarcode: raceBarcode }),
        request(appMod.default)
          .patch(`/api/cases/${case2Id}`)
          .set("Authorization", `Bearer ${tokens.admin}`)
          .send({ casePanBarcode: raceBarcode }),
      ]);

      const statuses = [r1.status, r2.status];
      expect(statuses).toContain(200);
      expect(statuses).toContain(409);

      // Message must come from rethrowBarcodeConflict (DB constraint path),
      // NOT from the pre-check (which would say "case #<number>").
      const loser = r1.status === 409 ? r1 : r2;
      const msg = loser.body.error ?? loser.body.message ?? "";
      expect(msg).toMatch(/another active case/i);
      expect(msg).not.toMatch(/case #/);
    } finally {
      casesMod._testHooks.barcodeWriteHook = undefined;
      const { db, cases } = dbMod as any;
      await db.delete(cases).where(inArray(cases.id, [case1Id, case2Id]));
    }
  });

  it("POST /api/cases race: DB constraint catches the loser when both requests clear the pre-check simultaneously", async () => {
    const raceBarcode = `RCPOST${randomBytes(4).toString("hex").toUpperCase()}`;

    // Latch: both requests block here until both have cleared checkBarcodeUniqueness.
    let arrivals = 0;
    let releaseAll!: () => void;
    const gateOpen = new Promise<void>((r) => { releaseAll = r; });
    casesMod._testHooks.barcodeWriteHook = async () => {
      arrivals++;
      if (arrivals >= 2) releaseAll();
      await gateOpen;
    };

    try {
      const [r1, r2] = await Promise.all([
        request(appMod.default)
          .post("/api/cases")
          .set("Authorization", `Bearer ${tokens.admin}`)
          .send({
            caseNumber: rid("RCP1"),
            labOrganizationId: labOrgId,
            providerOrganizationId: providerOrgId,
            patientFirstName: "Race",
            patientLastName: "One",
            doctorName: "Dr. Race",
            casePanBarcode: raceBarcode,
          }),
        request(appMod.default)
          .post("/api/cases")
          .set("Authorization", `Bearer ${tokens.admin}`)
          .send({
            caseNumber: rid("RCP2"),
            labOrganizationId: labOrgId,
            providerOrganizationId: providerOrgId,
            patientFirstName: "Race",
            patientLastName: "Two",
            doctorName: "Dr. Race",
            casePanBarcode: raceBarcode,
          }),
      ]);

      const statuses = [r1.status, r2.status];
      expect(statuses).toContain(201);
      expect(statuses).toContain(409);

      // Message must come from rethrowBarcodeConflict (DB constraint path),
      // NOT from the pre-check (which would say "case #<number>").
      const loser = r1.status === 409 ? r1 : r2;
      const msg = loser.body.error ?? loser.body.message ?? "";
      expect(msg).toMatch(/another active case/i);
      expect(msg).not.toMatch(/case #/);

      const winner = r1.status === 201 ? r1 : r2;
      const createdId = (winner.body.data?.case ?? winner.body.data)?.id;
      const { db, cases } = dbMod as any;
      if (createdId) {
        await db.delete(cases).where(eq(cases.id, createdId));
      }
    } finally {
      casesMod._testHooks.barcodeWriteHook = undefined;
    }
  });
});
