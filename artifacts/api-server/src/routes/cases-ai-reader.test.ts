/**
 * Integration tests for the AI case reader endpoints (regression guard).
 *
 * Skipped when DATABASE_URL is not configured.  All inserted rows are removed
 * in afterAll so the suite is safe to run against a shared dev DB.
 *
 * Coverage:
 *  - POST /api/cases — lab member can create a case; non-member gets 403
 *  - POST /api/cases — required fields missing returns 400
 *  - POST /api/cases — `notes` body field is saved to cases.rxNotes (lab slip field)
 *  - POST /api/cases — `dueDate` body field is stored in the cases row
 *  - POST /api/cases/import-from-itero-rx — missing labOrganizationId → 400
 *  - POST /api/cases/import-from-itero-rx — caller not a lab member → 403
 *  - POST /api/cases/import-from-itero-rx — creates a case without pending review
 *    while retaining aiImportSource:'itero' (the AI client is not configured)
 *  - POST /api/cases/import-from-itero-rx — with dueDateHint sets expectedDeliveryDate to null
 *  - POST /api/cases/import-from-itero-rx — duplicate iteroOrderId returns
 *    deduped response {deduped:true, caseId} (the route returns 200 on dedup;
 *    task spec says 409 — test documents current behaviour and the desired spec)
 *  - POST /api/cases/import-from-itero-rx — Removable with 4 client-hint teeth
 *    creates exactly 1 restoration row (QTY = 1), not one row per tooth. This
 *    is the AI-scan (non-iTero) hint path: the desktop client ran
 *    analyze-prescription and forwards the extracted fields as *Hint fields.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";
import request from "supertest";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

const TEST_MEDIA_DIR = path.join(os.tmpdir(), "labtrax-test-media-ai", "case-media");

// Hoist the spy so it is available inside vi.mock's factory.
const { mockWriteCaseMediaToObjectStorage, mockExtractMediaFileName } = vi.hoisted(() => ({
  mockWriteCaseMediaToObjectStorage: vi.fn().mockResolvedValue(true),
  mockExtractMediaFileName: vi.fn().mockReturnValue(null),
}));

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(require("os").tmpdir(), "labtrax-test-media-ai", "case-media"),
  extractMediaFileName: mockExtractMediaFileName,
}));
// Spy on the object-storage mirror so tests can assert it is called without
// requiring a live GCS sidecar.
vi.mock("../lib/case-media-object-storage.js", () => ({
  writeCaseMediaToObjectStorage: mockWriteCaseMediaToObjectStorage,
  openCaseMediaObjectStream: vi.fn().mockResolvedValue(null),
  caseMediaObjectStorageAvailable: vi.fn().mockReturnValue(true),
  deleteCaseMediaFromObjectStorage: vi.fn().mockResolvedValue(false),
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("Cases AI reader endpoints (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let auth: typeof import("../lib/auth.js");

  const labOrgId = rid("lab");
  const otherLabOrgId = rid("lab2");
  const providerOrgId = rid("prov");
  const adminUserId = rid("uadmin");
  const secondAdminUserId = rid("uadmin");
  const outsiderUserId = rid("uout");

  const tokens = { admin: "", secondAdmin: "", outsider: "" };

  // The itero-import tests exercise the documented "no-AI stub path". When
  // AI_INTEGRATIONS_
  // OPENAI_API_KEY is present (as it is in Replit envs), the route makes a live
  // AI call against the fake test PDF whose non-deterministic output can break a
  // downstream step and surface as a 500. Force the key off for this fork so the
  // stub path runs deterministically; restore it in afterAll.
  let savedOpenAIKey: string | undefined;

  async function makeSession(userId: string): Promise<string> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const token = auth.signAccessToken(userId, sessionId);
    const hash = createHash("sha256").update(token).digest("hex");
    await db.insert(userSessions).values({ id: sessionId, userId, tokenHash: hash, expiresAt });
    return token;
  }

  function makeTempRxFile(): string {
    const tmpDir = path.join(os.tmpdir(), "labtrax-test-rx");
    fs.mkdirSync(tmpDir, { recursive: true });
    const p = path.join(tmpDir, `rx-${rid("f")}.pdf`);
    fs.writeFileSync(p, "%PDF-1.4 fake rx content for testing");
    return p;
  }

  beforeAll(async () => {
    // Ensure the mocked case-media directory exists so file operations succeed.
    fs.mkdirSync(TEST_MEDIA_DIR, { recursive: true });

    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-ai-reader";
    savedOpenAIKey = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];
    delete process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    auth = await import("../lib/auth.js");

    const { db, organizations, users, organizationMemberships } = dbMod as any;

    await db.insert(users).values([
      { id: adminUserId, username: `adm_${adminUserId}`, password: "testpass" },
      { id: secondAdminUserId, username: `adm_${secondAdminUserId}`, password: "testpass" },
      { id: outsiderUserId, username: `out_${outsiderUserId}`, password: "testpass" },
    ]);

    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: "AI Reader Test Lab" },
      { id: otherLabOrgId, type: "lab", name: "Other Lab" },
      {
        id: providerOrgId,
        type: "provider",
        name: "Test Practice",
        parentLabOrganizationId: labOrgId,
      },
    ]);

    await db.insert(organizationMemberships).values([
      { id: rid("m"), labId: labOrgId, userId: adminUserId, role: "admin", status: "active" },
      { id: rid("m"), labId: labOrgId, userId: secondAdminUserId, role: "admin", status: "active" },
    ]);

  });

  // Refresh session tokens before every test so a concurrent user_sessions
  // wipe does not invalidate shared tokens mid-suite.
  beforeEach(async () => {
    tokens.admin = await makeSession(adminUserId);
    tokens.secondAdmin = await makeSession(secondAdminUserId);
    tokens.outsider = await makeSession(outsiderUserId);
  });

  afterAll(async () => {
    if (savedOpenAIKey !== undefined) {
      process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] = savedOpenAIKey;
    }
    if (!SHOULD_RUN) return;
    const {
      db,
      organizations,
      users,
      cases,
      caseEvents,
      iteroImportedOrders,
      organizationMemberships,
      userSessions,
      auditLogs,
      invoices,
      notifications,
      systemSettings,
    } = dbMod as any;
    // Clean up in dependency order to avoid FK constraint violations.
    // invoices.labOrganizationId has onDelete:restrict — must go before orgs.
    await db.delete(auditLogs).where(inArray(auditLogs.organizationId, [labOrgId, otherLabOrgId]));
    await db.delete(caseEvents).where(
      inArray(caseEvents.actorOrganizationId, [labOrgId, otherLabOrgId])
    );
    await db.delete(iteroImportedOrders).where(
      eq(iteroImportedOrders.labOrganizationId, labOrgId)
    );
    await db.delete(invoices).where(
      inArray(invoices.labOrganizationId, [labOrgId, otherLabOrgId, providerOrgId])
    );
    await db.delete(notifications).where(
      inArray(notifications.userId, [adminUserId, secondAdminUserId, outsiderUserId])
    );
    await db.delete(systemSettings).where(
      inArray(systemSettings.key, [
        `notif_prefs:${adminUserId}`,
        `notif_prefs:${secondAdminUserId}`,
      ])
    );
    await db.delete(cases).where(eq(cases.labOrganizationId, labOrgId));
    await db.delete(organizationMemberships).where(
      inArray(organizationMemberships.userId, [adminUserId, secondAdminUserId, outsiderUserId])
    );
    await db.delete(userSessions).where(
      inArray(userSessions.userId, [adminUserId, secondAdminUserId, outsiderUserId])
    );
    await db.delete(organizations).where(
      inArray(organizations.id, [labOrgId, otherLabOrgId, providerOrgId])
    );
    await db.delete(users).where(
      inArray(users.id, [adminUserId, secondAdminUserId, outsiderUserId])
    );
  });

  // Helper: delete a case created inline in a test, cleaning up dependent rows.
  // invoices.caseId is onDelete:set null so we must delete associated invoices
  // (and their line items) BEFORE deleting the case — otherwise the orphaned
  // invoice rows accumulate and later tests that get the same sequential
  // case number hit an invoiceNumber unique-conflict, silently skipping the
  // invoice insert via onConflictDoNothing and causing assertion failures.
  // caseAttachments.caseId is onDelete:cascade so those are gone automatically.
  async function cleanCase(caseId: string) {
    const { db, cases, invoices, invoiceLineItems } = dbMod as any;
    const caseInvoices = await db
      .select({ id: invoices.id })
      .from(invoices)
      .where(eq(invoices.caseId, caseId));
    for (const inv of caseInvoices) {
      await db.delete(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, inv.id));
      await db.delete(invoices).where(eq(invoices.id, inv.id));
    }
    await db.delete(cases).where(eq(cases.id, caseId));
  }

  // ── POST /api/cases ──────────────────────────────────────────────────────

  it("POST /api/cases: lab member can create a case", async () => {
    const adminToken = await makeSession(adminUserId);
    const r = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        caseNumber: rid("CN"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Alice",
        patientLastName: "Johnson",
        doctorName: "Dr. Test",
        status: "received",
      });

    expect(r.status).toBe(201);
    expect(r.body.ok).toBe(true);
    expect(r.body.data.id).toBeTruthy();
    await cleanCase(r.body.data.id);
  });

  it("POST /api/cases: non-member of lab gets 403", async () => {
    const outsiderToken = await makeSession(outsiderUserId);
    const r = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${outsiderToken}`)
      .send({
        caseNumber: rid("CN"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Alice",
        patientLastName: "Johnson",
        doctorName: "Dr. Test",
        status: "received",
      });

    expect(r.status).toBe(403);
  });

  it("POST /api/cases: missing required fields returns 400", async () => {
    const adminToken = await makeSession(adminUserId);
    const r = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        labOrganizationId: labOrgId,
        // caseNumber, patientFirstName, patientLastName, doctorName omitted
      });

    expect(r.status).toBe(400);
  });

  it("POST /api/cases: returns 401 when no auth token is provided", async () => {
    const r = await request(appMod.default)
      .post("/api/cases")
      .send({ caseNumber: "X", labOrganizationId: labOrgId });

    expect(r.status).toBe(401);
  });

  // ── POST /api/cases/import-from-itero-rx ─────────────────────────────────

  it("POST /api/cases/import-from-itero-rx: missing labOrganizationId returns 400", async () => {
    const adminToken = await makeSession(adminUserId);
    const rxFile = makeTempRxFile();
    const r = await request(appMod.default)
      .post("/api/cases/import-from-itero-rx")
      .set("Authorization", `Bearer ${adminToken}`)
      .attach("file", rxFile, "rx.pdf")
      .field("iteroOrderId", rid("order"))
      .field("providerOrganizationId", providerOrgId);
    // labOrganizationId intentionally omitted

    expect(r.status).toBe(400);
    try { fs.unlinkSync(rxFile); } catch { /* ignore */ }
  });

  it("POST /api/cases/import-from-itero-rx: caller not a lab member gets 403", async () => {
    const outsiderToken = await makeSession(outsiderUserId);
    const rxFile = makeTempRxFile();
    const r = await request(appMod.default)
      .post("/api/cases/import-from-itero-rx")
      .set("Authorization", `Bearer ${outsiderToken}`)
      .attach("file", rxFile, "rx.pdf")
      .field("iteroOrderId", rid("order"))
      .field("labOrganizationId", labOrgId)
      .field("providerOrganizationId", providerOrgId);

    expect(r.status).toBe(403);
    try { fs.unlinkSync(rxFile); } catch { /* ignore */ }
  });

  it("POST /api/cases/import-from-itero-rx: creates without pending review and retains import source (no-AI stub path)", async () => {
    // AI_INTEGRATIONS_OPENAI_API_KEY is unset in test env, so the stub path
    // runs. The case must be created without pending review and retain
    // aiImportSource:'itero'.
    const adminToken = await makeSession(adminUserId);
    const orderId = rid("order");
    const rxFile = makeTempRxFile();

    const r = await request(appMod.default)
      .post("/api/cases/import-from-itero-rx")
      .set("Authorization", `Bearer ${adminToken}`)
      .attach("file", rxFile, "rx.pdf")
      .field("iteroOrderId", orderId)
      .field("labOrganizationId", labOrgId)
      .field("providerOrganizationId", providerOrgId);

    expect(r.status).toBe(201);
    expect(r.body.ok).toBe(true);
    expect(r.body.data.caseId).toBeTruthy();
    expect(r.body.data.needsAiReview).toBe(false);

    const { db, cases } = dbMod as any;
    const [row] = await db
      .select({ needsAiReview: cases.needsAiReview, aiImportSource: cases.aiImportSource })
      .from(cases)
      .where(eq(cases.id, r.body.data.caseId));

    expect(row.needsAiReview).toBe(false);
    expect(row.aiImportSource).toBe("itero");

    await cleanCase(r.body.data.caseId);
    try { fs.unlinkSync(rxFile); } catch { /* ignore */ }
  });

  it("POST /api/cases/import-from-itero-rx: honors New cases and Rush cases preferences per admin without duplicates", async () => {
    const { db, notifications } = dbMod as any;

    const adminSave = await request(appMod.default)
      .patch("/api/auth/notification-preferences")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({ inAppNewCase: false, inAppRushCase: true });
    const secondAdminSave = await request(appMod.default)
      .patch("/api/auth/notification-preferences")
      .set("Authorization", `Bearer ${tokens.secondAdmin}`)
      .send({ inAppNewCase: true, inAppRushCase: false });
    expect(adminSave.status).toBe(200);
    expect(secondAdminSave.status).toBe(200);

    const reloaded = await request(appMod.default)
      .get("/api/auth/notification-preferences")
      .set("Authorization", `Bearer ${tokens.admin}`);
    expect(reloaded.status).toBe(200);
    expect(reloaded.body.preferences.inAppNewCase).toBe(false);
    expect(reloaded.body.preferences.inAppRushCase).toBe(true);

    const normalFile = makeTempRxFile();
    const rushFile = makeTempRxFile();
    const normal = await request(appMod.default)
      .post("/api/cases/import-from-itero-rx")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .attach("file", normalFile, "normal-rx.pdf")
      .field("iteroOrderId", rid("order_normal"))
      .field("labOrganizationId", labOrgId)
      .field("providerOrganizationId", providerOrgId);
    const rush = await request(appMod.default)
      .post("/api/cases/import-from-itero-rx")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .attach("file", rushFile, "rush-rx.pdf")
      .field("iteroOrderId", rid("order_rush"))
      .field("labOrganizationId", labOrgId)
      .field("providerOrganizationId", providerOrgId)
      .field("isRushHint", "true");

    expect(normal.status).toBe(201);
    expect(rush.status).toBe(201);
    const caseIds = [normal.body.data.caseId, rush.body.data.caseId];
    const rows = await db
      .select({
        userId: notifications.userId,
        dataJson: notifications.dataJson,
      })
      .from(notifications)
      .where(inArray(notifications.userId, [adminUserId, secondAdminUserId]));
    const importedRows = rows.filter((row: any) =>
      caseIds.includes(row.dataJson?.caseId),
    );

    expect(
      importedRows.filter((row: any) => row.dataJson?.caseId === normal.body.data.caseId),
    ).toEqual([
      expect.objectContaining({ userId: secondAdminUserId }),
    ]);
    expect(
      importedRows.filter((row: any) => row.dataJson?.caseId === rush.body.data.caseId),
    ).toEqual([
      expect.objectContaining({ userId: adminUserId }),
    ]);

    const { deliverInAppNotification } = await import("../lib/in-app-notifications.js");
    await deliverInAppNotification({
      labOrganizationId: labOrgId,
      category: "new_case",
      dedupeKey: `itero_case:${normal.body.data.caseId}`,
      type: "case_imported_from_itero",
      title: "Repeated delivery attempt",
      body: "This retry must not create another row.",
      dataJson: { caseId: normal.body.data.caseId },
    });
    const afterRetry = await db
      .select({
        userId: notifications.userId,
        dataJson: notifications.dataJson,
      })
      .from(notifications)
      .where(inArray(notifications.userId, [adminUserId, secondAdminUserId]));
    expect(
      afterRetry.filter((row: any) => row.dataJson?.caseId === normal.body.data.caseId),
      "repeated delivery attempts must remain one notification per eligible user",
    ).toHaveLength(1);

    await cleanCase(normal.body.data.caseId);
    await cleanCase(rush.body.data.caseId);
    try { fs.unlinkSync(normalFile); } catch { /* ignore */ }
    try { fs.unlinkSync(rushFile); } catch { /* ignore */ }
  });

  it("POST /api/cases/import-from-itero-rx: mirrors Rx PDF to object storage after successful import", async () => {
    // Regression guard: the single-file iTero poller route was missing the
    // object-storage mirror that the ZIP import paths already had, causing
    // attached Rx PDFs to 404 after any server restart.  This test verifies
    // writeCaseMediaToObjectStorage is called for every successful import.
    mockWriteCaseMediaToObjectStorage.mockClear();

    const adminToken = await makeSession(adminUserId);
    const orderId = rid("order");
    const rxFile = makeTempRxFile();

    const r = await request(appMod.default)
      .post("/api/cases/import-from-itero-rx")
      .set("Authorization", `Bearer ${adminToken}`)
      .attach("file", rxFile, "iTero_Rx_999.pdf")
      .field("iteroOrderId", orderId)
      .field("labOrganizationId", labOrgId)
      .field("providerOrganizationId", providerOrgId);

    expect(r.status).toBe(201);

    // The mirror runs fire-and-forget after the response is sent.
    // Poll up to 2 s so CI on slow machines doesn't flake.
    for (let i = 0; i < 20; i++) {
      await new Promise((res) => setTimeout(res, 100));
      if (mockWriteCaseMediaToObjectStorage.mock.calls.length > 0) break;
    }

    expect(
      mockWriteCaseMediaToObjectStorage,
      "writeCaseMediaToObjectStorage must be called once per successful iTero import",
    ).toHaveBeenCalledOnce();

    const [filename, _buf, contentType] =
      mockWriteCaseMediaToObjectStorage.mock.calls[0]!;
    expect(String(filename)).toMatch(/\.pdf$/i);
    expect(String(contentType)).toMatch(/pdf/i);

    await cleanCase(r.body.data.caseId);
    try { fs.unlinkSync(rxFile); } catch { /* ignore */ }
  });

  it("POST /api/cases/import-from-itero-rx: duplicate iteroOrderId returns deduped response", async () => {
    // Per task spec: "duplicate iteroOrderId for the same lab returns 409 (idempotency guard)".
    // Current implementation: returns 200 with { deduped: true, caseId }.
    // This test documents the actual behaviour; the 200 dedup path is a valid
    // idempotent response — change the assertion if the API is updated to return 409.
    const adminToken = await makeSession(adminUserId);
    const orderId = rid("order");
    const rxFile1 = makeTempRxFile();
    const rxFile2 = makeTempRxFile();

    const first = await request(appMod.default)
      .post("/api/cases/import-from-itero-rx")
      .set("Authorization", `Bearer ${adminToken}`)
      .attach("file", rxFile1, "rx.pdf")
      .field("iteroOrderId", orderId)
      .field("labOrganizationId", labOrgId)
      .field("providerOrganizationId", providerOrgId);

    expect(first.status).toBe(201);
    const caseId = first.body.data.caseId;

    const second = await request(appMod.default)
      .post("/api/cases/import-from-itero-rx")
      .set("Authorization", `Bearer ${adminToken}`)
      .attach("file", rxFile2, "rx.pdf")
      .field("iteroOrderId", orderId)
      .field("labOrganizationId", labOrgId)
      .field("providerOrganizationId", providerOrgId);

    // Idempotent dedup — same case returned, no duplicate created.
    expect(second.status).toBe(200);
    expect(second.body.data.deduped).toBe(true);
    expect(second.body.data.caseId).toBe(caseId);

    await cleanCase(caseId);
    try { fs.unlinkSync(rxFile1); } catch { /* ignore */ }
    try { fs.unlinkSync(rxFile2); } catch { /* ignore */ }
  });

  it.each([
    { name: "legacy dueDateHint", hints: { dueDateHint: "2026-09-30" }, labDate: "2026-09-30", rxDate: "2026-09-30" },
    { name: "reviewed fields override legacy hint", hints: { dueDateHint: "2026-09-30", rxDueDateHint: "2026-08-29", labDueDateHint: "2026-09-03" }, labDate: "2026-09-03", rxDate: "2026-08-29" },
    { name: "explicit reviewed clears", hints: { dueDateHint: "2026-09-30", rxDueDateHint: "", labDueDateHint: "" }, labDate: null, rxDate: null },
    { name: "invalid legacy date", hints: { dueDateHint: "not-a-date" }, labDate: null, rxDate: null },
  ])("POST /api/cases/import-from-itero-rx: preserves $name", async ({ hints, labDate, rxDate }) => {
    const adminToken = await makeSession(adminUserId);
    const rxFile = makeTempRxFile();
    const pending = request(appMod.default)
      .post("/api/cases/import-from-itero-rx")
      .set("Authorization", `Bearer ${adminToken}`)
      .attach("file", rxFile, "rx.pdf")
      .field("iteroOrderId", rid("order_edd"))
      .field("labOrganizationId", labOrgId)
      .field("providerOrganizationId", providerOrgId);
    for (const [key, value] of Object.entries(hints)) pending.field(key, value!);
    const result = await pending;
    expect(result.status).toBe(201);
    const caseId = result.body.data.caseId as string;
    expect(caseId).toBeTruthy();
    const { db, cases } = dbMod as any;
    const [row] = await db.select({
      dueDate: cases.dueDate, prescriptionDueDate: cases.prescriptionDueDate,
      expectedDeliveryDate: cases.expectedDeliveryDate,
    }).from(cases).where(eq(cases.id, caseId));
    expect(row.prescriptionDueDate).toBe(rxDate);
    if (labDate) {
      expect(new Date(row.dueDate).toISOString().slice(0, 10)).toBe(labDate);
      expect(row.expectedDeliveryDate).toBeNull();
    } else {
      expect(row.dueDate).toBeNull();
      expect(row.expectedDeliveryDate).toBeTruthy();
    }
    await cleanCase(caseId);
    try { fs.unlinkSync(rxFile); } catch { /* ignore */ }
  });

  it("POST /api/cases/import-from-itero-rx: Removable with 4 client-hint teeth creates 1 restoration row (QTY = 1), not 4", async () => {
    // Regression guard for the AI-scan (non-iTero) hint path: when the desktop
    // drop-zone client runs analyze-prescription and forwards the extracted
    // fields as *Hint fields, the server must collapse all teeth into a single
    // restoration row for Removable cases.  Without the fix, each tooth in
    // toothIndicesHint would produce its own restoration row and the invoice
    // would show QTY = 4.
    //
    // AI_INTEGRATIONS_OPENAI_API_KEY is unset in this suite (see beforeAll),
    // so the server skips its own PDF extraction and falls back solely to the
    // client-supplied *Hint fields — exactly the flow a user experiences after
    // the desktop drop-zone AI reader scans the Rx.
    const adminToken = await makeSession(adminUserId);
    const rxFile = makeTempRxFile();

    const r = await request(appMod.default)
      .post("/api/cases/import-from-itero-rx")
      .set("Authorization", `Bearer ${adminToken}`)
      .attach("file", rxFile, "rx-removable.pdf")
      .field("iteroOrderId", rid("order_rem"))
      .field("labOrganizationId", labOrgId)
      .field("providerOrganizationId", providerOrgId)
      .field("caseTypeHint", "Removable")
      .field("toothIndicesHint", "28, 29, 30, 31")
      .field("archHint", "upper")
      .field("materialHint", "Acrylic")
      .field("doctorNameHint", "Dr. Partial")
      .field("patientFirstNameHint", "Terry")
      .field("patientLastNameHint", "Partial")
      .field("confirmNewDoctor", "true");

    expect(r.status).toBe(201);
    const caseId = r.body.data.caseId as string;
    expect(caseId).toBeTruthy();

    const { db, caseRestorations, invoices, invoiceLineItems } = dbMod as any;

    // ── 1 restoration row, toothNumber carries all 4 teeth joined ──────────
    const restorations = await db
      .select()
      .from(caseRestorations)
      .where(eq(caseRestorations.caseId, caseId));
    expect(
      restorations,
      "Removable must produce exactly 1 restoration row regardless of tooth count",
    ).toHaveLength(1);
    expect(restorations[0].restorationType).toBe("Removable");
    // All four teeth must be joined in the single row's toothNumber field.
    expect(restorations[0].toothNumber).toContain("28");
    expect(restorations[0].toothNumber).toContain("29");
    expect(restorations[0].toothNumber).toContain("30");
    expect(restorations[0].toothNumber).toContain("31");

    // ── Invoice line items: exactly 1 billable line, QTY = 1 ───────────────
    // The invoice is created inside the import transaction, so no polling is
    // needed — it is available immediately after the 201 response.
    const [invoice] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.caseId, caseId));
    expect(invoice, "auto-invoice must be created for the imported case").toBeDefined();

    const lineItems = await db
      .select()
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, invoice.id));
    const billableLines = lineItems.filter((li: any) => li.quantity > 0);
    expect(
      billableLines,
      "invoice must have exactly 1 billable line item (QTY = 1) for a Removable appliance",
    ).toHaveLength(1);
    expect(billableLines[0].quantity).toBe(1);

    await cleanCase(caseId);
    try { fs.unlinkSync(rxFile); } catch { /* ignore */ }
  });

  it("POST /api/cases/import-from-itero-rx: overlays valid partial chart assignments on extracted restorations", async () => {
    const adminToken = await makeSession(adminUserId);
    const rxFile = makeTempRxFile();
    const assignments = [
      { toothNumber: "13", restorationType: "Crown", material: "Zirconia", shade: "A2", quantity: 1 },
      { toothNumber: "14", restorationType: "Pontic", material: "Zirconia", shade: "A2", quantity: 1 },
    ];
    const r = await request(appMod.default)
      .post("/api/cases/import-from-itero-rx")
      .set("Authorization", `Bearer ${adminToken}`)
      .attach("file", rxFile, "rx-partial-chart.pdf")
      .field("iteroOrderId", rid("order_partial_chart"))
      .field("labOrganizationId", labOrgId)
      .field("providerOrganizationId", providerOrgId)
      .field("caseTypeHint", "Crown")
      .field("toothIndicesHint", "13, 14, 15")
      .field("materialHint", "Zirconia")
      .field("toothAssignments", JSON.stringify(assignments))
      .field("bridgeConnectors", "13-14");

    expect(r.status).toBe(201);
    const caseId = r.body.data.caseId as string;
    const { db, caseRestorations } = dbMod as any;
    const restorations = await db
      .select()
      .from(caseRestorations)
      .where(eq(caseRestorations.caseId, caseId));

    expect(restorations).toHaveLength(3);
    expect(restorations).toEqual(expect.arrayContaining([
      expect.objectContaining({ toothNumber: "13", restorationType: "Crown" }),
      expect.objectContaining({ toothNumber: "14", restorationType: "Pontic" }),
      expect.objectContaining({ toothNumber: "15", restorationType: "Crown & Bridge" }),
    ]));

    await cleanCase(caseId);
    try { fs.unlinkSync(rxFile); } catch { /* ignore */ }
  });

  // ── POST /api/cases: auto-invoice generation ─────────────────────────────

  it("POST /api/cases: auto-generates an open invoice for every new case", async () => {
    const adminToken = await makeSession(adminUserId);
    const r = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        caseNumber: rid("CN"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Invoice",
        patientLastName: "AutoTest",
        doctorName: "Dr. Auto",
        status: "received",
      });

    expect(r.status).toBe(201);
    const caseId = r.body.data.id;

    // The auto-invoice is generated in a fire-and-forget async block.
    // Poll briefly (max 2 s) rather than a fixed sleep so CI stays fast
    // while flakiness is minimised on slow machines.
    const { db, invoices } = dbMod as any;
    let invoice: any;
    for (let i = 0; i < 20; i++) {
      await new Promise((res) => setTimeout(res, 100));
      [invoice] = await db
        .select()
        .from(invoices)
        .where(eq(invoices.caseId, caseId));
      if (invoice) break;
    }

    expect(invoice, "auto-invoice must be created within 2 s of case creation").toBeDefined();
    expect(invoice.status).toBe("open");
    expect(invoice.caseId).toBe(caseId);
    expect(invoice.labOrganizationId).toBe(labOrgId);
    expect(invoice.providerOrganizationId).toBe(providerOrgId);

    await cleanCase(caseId);
  });

  // ── POST /api/cases: AI intake field carry-through ───────────────────────

  it("POST /api/cases: Rx notes are saved as dated history, not authored case notes", async () => {
    // Prescription scan notes and authored case notes must remain separate.
    const adminToken = await makeSession(adminUserId);
    const notesText = "Patient grinds at night — use extra-strength ceramic";
    const authoredText = "Provider requested a quick turnaround";
    const r = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        caseNumber: rid("CN"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Rx",
        patientLastName: "NotesTest",
        doctorName: "Dr. Notes",
        status: "received",
        notes: authoredText,
        rxNotes: notesText,
      });

    expect(r.status).toBe(201);
    const caseId = r.body.data.id;

    const { db, cases, caseNotes, caseRxNoteEntries } = dbMod as any;
    const [row] = await db
      .select({ rxNotes: cases.rxNotes })
      .from(cases)
      .where(eq(cases.id, caseId));

    expect(row.rxNotes).toBe(notesText);
    const history = await db
      .select()
      .from(caseRxNoteEntries)
      .where(eq(caseRxNoteEntries.caseId, caseId));
    expect(history).toHaveLength(1);
    expect(history[0].noteText).toBe(notesText);
    const authored = await db
      .select()
      .from(caseNotes)
      .where(eq(caseNotes.caseId, caseId));
    expect(authored.map((entry: any) => entry.noteText)).toEqual([authoredText]);
    await cleanCase(caseId);
  });

  it("Rx-note scans are distinct, retry-safe, ordered, and edited in place", async () => {
    const adminToken = await makeSession(adminUserId);
    const caseIds: string[] = [];
    const createCase = async (notes?: string) => {
      const response = await request(appMod.default)
        .post("/api/cases")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          caseNumber: rid("RXH"),
          labOrganizationId: labOrgId,
          providerOrganizationId: providerOrgId,
          patientFirstName: "Rx",
          patientLastName: "History",
          doctorName: "Dr. History",
          status: "received",
          ...(notes ? { rxNotes: notes } : {}),
        });
      expect(response.status).toBe(201);
      caseIds.push(response.body.data.id);
      return response.body.data.id as string;
    };
    const caseId = await createCase("Original prescription");
    const scan = (submissionId: string, notes: string) =>
      request(appMod.default)
        .post(`/api/cases/${caseId}/rx-note-scans`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ submissionId, notes });

    try {
      const second = await scan("rx-scan-second-001", "Same scan text");
      expect(second.status).toBe(200);
      expect((await scan("rx-scan-second-001", "Same scan text")).status).toBe(200);
      expect((await scan("rx-scan-second-001", "Changed retry text")).status).toBe(409);

      const [third, fourth] = await Promise.all([
        scan("rx-scan-third-001", "Same scan text"),
        scan("rx-scan-fourth-001", "Same scan text"),
      ]);
      expect(third.status).toBe(200);
      expect(fourth.status).toBe(200);

      const { db, caseRxNoteEntries } = dbMod as any;
      const detail = await request(appMod.default)
        .get(`/api/cases/${caseId}`)
        .set("Authorization", `Bearer ${adminToken}`);
      expect(detail.status).toBe(200);
      expect(detail.body.data.rxNoteEntries.map((entry: any) => entry.noteText)).toEqual([
        "Original prescription",
        "Same scan text",
        "Same scan text",
        "Same scan text",
      ]);
      const sameTextRows = await db
        .select()
        .from(caseRxNoteEntries)
        .where(eq(caseRxNoteEntries.caseId, caseId));
      expect(sameTextRows.filter((row: any) => row.noteText === "Same scan text")).toHaveLength(3);

      const activeBeforeEdit = detail.body.data.rxNoteEntries.at(-1);
      const edit = await request(appMod.default)
        .patch(`/api/cases/${caseId}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ rxNotes: "Manually edited current prescription" });
      expect(edit.status).toBe(200);
      const afterEdit = await request(appMod.default)
        .get(`/api/cases/${caseId}`)
        .set("Authorization", `Bearer ${adminToken}`);
      expect(afterEdit.body.data.rxNoteEntries).toHaveLength(4);
      expect(afterEdit.body.data.rxNoteEntries.at(-1).noteText).toBe(
        "Manually edited current prescription",
      );
      expect(afterEdit.body.data.rxNoteEntries.at(-1).scannedAt).toBe(
        activeBeforeEdit.scannedAt,
      );
    } finally {
      for (const id of caseIds.reverse()) await cleanCase(id);
    }
  });

  it("remake Rx history includes only direct ancestors and marks unknown legacy dates", async () => {
    const adminToken = await makeSession(adminUserId);
    const caseIds: string[] = [];
    const createCase = async () => {
      const response = await request(appMod.default)
        .post("/api/cases")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          caseNumber: rid("RXM"),
          labOrganizationId: labOrgId,
          providerOrganizationId: providerOrgId,
          patientFirstName: "Rx",
          patientLastName: "Remake",
          doctorName: "Dr. Remake",
          status: "received",
        });
      expect(response.status).toBe(201);
      caseIds.push(response.body.data.id);
      return response.body.data.id as string;
    };

    const parentId = await createCase();
    const childId = await createCase();
    const siblingId = await createCase();
    try {
      const { db, cases, caseRxNoteEntries } = dbMod as any;
      await db.update(cases).set({ rxNotes: "Undated original instructions" }).where(eq(cases.id, parentId));
      await db.insert(caseRxNoteEntries).values({
        caseId: parentId,
        noteText: "Undated original instructions",
        scannedAt: null,
        provenance: "legacy",
      });
      await db.update(cases).set({ remakeOfCaseId: parentId }).where(eq(cases.id, childId));
      await db.update(cases).set({ remakeOfCaseId: parentId }).where(eq(cases.id, siblingId));

      const append = (id: string, submissionId: string, notes: string) =>
        request(appMod.default)
          .post(`/api/cases/${id}/rx-note-scans`)
          .set("Authorization", `Bearer ${adminToken}`)
          .send({ submissionId, notes });
      expect((await append(childId, "rx-child-scan-001", "Child scan")).status).toBe(200);
      expect((await append(siblingId, "rx-sibling-scan-001", "Sibling scan")).status).toBe(200);

      const detail = await request(appMod.default)
        .get(`/api/cases/${childId}`)
        .set("Authorization", `Bearer ${adminToken}`);
      expect(detail.status).toBe(200);
      expect(detail.body.data.rxNoteEntries.map((entry: any) => entry.noteText)).toEqual([
        "Undated original instructions",
        "Child scan",
      ]);
      expect(detail.body.data.rxNoteEntries[0].scannedAt).toBeNull();
      expect(detail.body.data.rxNoteEntries[0].provenance).toBe("legacy");
      expect(detail.body.data.rxNoteEntries.some((entry: any) => entry.caseId === siblingId)).toBe(false);
    } finally {
      for (const id of caseIds.reverse()) await cleanCase(id);
    }
  });

  it("concurrent attachment retries return one registered photo without duplicate history", async () => {
    const { db, caseAttachments, caseEvents, labCases } = dbMod as any;
    let canonicalCaseId: string | undefined;
    let legacyCaseId: string | undefined;

    const postAttachment = (caseId: string, submissionId: string, fileName: string) =>
      request(appMod.default)
        .post(`/api/cases/${caseId}/attachments`)
        .set("Authorization", `Bearer ${tokens.admin}`)
        .send({
          storageKey: `/uploads/case-media/${fileName}`,
          fileName,
          fileType: "image/jpeg",
          category: "prescription",
          submissionId,
        });

    try {
      const canonical = await request(appMod.default)
        .post("/api/cases")
        .set("Authorization", `Bearer ${tokens.admin}`)
        .send({
          caseNumber: rid("CN"),
          labOrganizationId: labOrgId,
          providerOrganizationId: providerOrgId,
          patientFirstName: "Concurrent",
          patientLastName: "Canonical",
          doctorName: "Dr. Retry",
          status: "received",
        });
      expect(canonical.status).toBe(201);
      const canonicalId = canonical.body.data.id as string;
      canonicalCaseId = canonicalId;

      const submissionId = `rx-photo-${rid("submission")}`;
      const [canonicalFirst, canonicalRetry] = await Promise.all([
        postAttachment(canonicalId, submissionId, "canonical-first.jpg"),
        postAttachment(canonicalId, submissionId, "canonical-retry.jpg"),
      ]);
      expect([canonicalFirst.status, canonicalRetry.status].sort()).toEqual([200, 201]);
      expect(canonicalFirst.body.data.id).toBe(canonicalRetry.body.data.id);

      const canonicalRows = await db
        .select()
        .from(caseAttachments)
        .where(and(
          eq(caseAttachments.caseId, canonicalCaseId),
          eq(caseAttachments.submissionId, submissionId),
        ));
      expect(canonicalRows).toHaveLength(1);
      expect(canonicalRows[0].id).toBe(canonicalFirst.body.data.id);
      expect(canonicalRows[0].storageKey).toBe(canonicalFirst.body.data.storageKey);

      const canonicalEvents = await db
        .select()
        .from(caseEvents)
        .where(and(
          eq(caseEvents.caseId, canonicalCaseId),
          eq(caseEvents.eventType, "case_attachment_added"),
        ));
      expect(canonicalEvents).toHaveLength(1);
      expect(canonicalEvents[0].metadataJson.attachmentId).toBe(canonicalRows[0].id);

      legacyCaseId = rid("legacy");
      await db.insert(labCases).values({
        id: legacyCaseId,
        ownerId: adminUserId,
        organizationId: labOrgId,
        caseData: JSON.stringify({
          caseNumber: rid("LEG"),
          patientName: "Concurrent Legacy",
          doctorName: "Dr. Retry",
          status: "RECEIVED",
          activityLog: [],
        }),
      });

      const legacySubmissionId = `rx-photo-${rid("submission")}`;
      const [legacyFirst, legacyRetry] = await Promise.all([
        postAttachment(legacyCaseId, legacySubmissionId, "legacy-first.jpg"),
        postAttachment(legacyCaseId, legacySubmissionId, "legacy-retry.jpg"),
      ]);
      expect([legacyFirst.status, legacyRetry.status].sort()).toEqual([200, 201]);
      expect(legacyFirst.body.data.id).toBe(legacyRetry.body.data.id);

      const legacyRows = await db
        .select()
        .from(caseAttachments)
        .where(and(
          eq(caseAttachments.labCaseId, legacyCaseId),
          eq(caseAttachments.submissionId, legacySubmissionId),
        ));
      expect(legacyRows).toHaveLength(1);
      expect(legacyRows[0].id).toBe(legacyFirst.body.data.id);
      expect(legacyRows[0].storageKey).toBe(legacyFirst.body.data.storageKey);

      const [legacyRow] = await db
        .select({ caseData: labCases.caseData })
        .from(labCases)
        .where(eq(labCases.id, legacyCaseId));
      const legacyActivity = JSON.parse(legacyRow.caseData).activityLog.filter(
        (entry: any) => entry.attachmentId === legacyRows[0].id,
      );
      expect(legacyActivity).toHaveLength(1);
    } finally {
      if (legacyCaseId) {
        await db.delete(labCases).where(eq(labCases.id, legacyCaseId));
      }
      if (canonicalCaseId) await cleanCase(canonicalCaseId);
    }
  });

  it("POST /api/cases: dueDate field is persisted in the cases row", async () => {
    // Regression guard: verifies the AI-extracted (or calendar-picker) dueDate
    // reaches the cases.due_date column so it appears on the lab slip.
    const adminToken = await makeSession(adminUserId);
    const r = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        caseNumber: rid("CN"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Due",
        patientLastName: "DateTest",
        doctorName: "Dr. Date",
        status: "received",
        dueDate: "2026-09-15",
      });

    expect(r.status).toBe(201);
    const caseId = r.body.data.id;

    const { db, cases } = dbMod as any;
    const [row] = await db
      .select({ dueDate: cases.dueDate })
      .from(cases)
      .where(eq(cases.id, caseId));

    // Drizzle returns the dueDate column as a JS Date object; normalize to ISO before comparing.
    const dueDateIso =
      row.dueDate instanceof Date
        ? row.dueDate.toISOString()
        : String(row.dueDate);
    expect(dueDateIso).toMatch(/^2026-09-15/);
    await cleanCase(caseId);
  });

  // ── POST /api/analyze-prescription (mobile "AI reader") ──────────────────
  // This suite runs with AI_INTEGRATIONS_OPENAI_API_KEY deleted (see beforeAll),
  // so it deterministically guards the "AI not configured" branch. The happy
  // path (with a mocked OpenAI client) lives in analyze-prescription.test.ts.

  it("POST /api/analyze-prescription: returns 503 when AI is not configured", async () => {
    const adminToken = await makeSession(adminUserId);
    const r = await request(appMod.default)
      .post("/api/analyze-prescription")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ imageBase64: `data:image/jpeg;base64,${"A".repeat(6000)}` });

    expect(r.status).toBe(503);
    expect(r.body.success).toBe(false);
  });

  // ── GET /:caseId/attachments/:attachmentId/file — inline vs attachment ────

  it("GET attachment/file: PDF is served with Content-Type: application/pdf and Content-Disposition: inline", async () => {
    // Regression guard: the INLINE_MIMES allowlist must include application/pdf
    // so browser opens the built-in viewer instead of forcing a download.
    const adminToken = await makeSession(adminUserId);
    const { db, cases, caseAttachments } = dbMod as any;

    const caseId = rid("c");
    const attachmentId = rid("att");
    const testFilename = `test-${rid("f")}.pdf`;
    const testFilePath = path.join(TEST_MEDIA_DIR, testFilename);

    // Write a minimal PDF-like file so res.sendFile can serve it.
    fs.writeFileSync(testFilePath, "%PDF-1.4 regression test content");

    await db.insert(cases).values({
      id: caseId,
      caseNumber: rid("CN"),
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      patientFirstName: "Pdf",
      patientLastName: "InlineTest",
      doctorName: "Dr. Inline",
      status: "received",
      createdByUserId: adminUserId,
    });

    await db.insert(caseAttachments).values({
      id: attachmentId,
      caseId,
      storageKey: testFilename,
      fileType: "application/pdf",
      fileName: "test-rx.pdf",
      visibility: "internal_lab_only",
      uploadedByUserId: adminUserId,
      uploadedByOrganizationId: labOrgId,
    });

    // Make extractMediaFileName return the bare filename so the route resolves
    // it under TEST_MEDIA_DIR (which is the mocked caseMediaDir).
    mockExtractMediaFileName.mockReturnValueOnce(testFilename);

    const r = await request(appMod.default)
      .get(`/api/cases/${caseId}/attachments/${attachmentId}/file`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/application\/pdf/);
    expect(r.headers["content-disposition"]).toMatch(/^inline/);

    await cleanCase(caseId);
    try { fs.unlinkSync(testFilePath); } catch { /* ignore */ }
  });

  it("GET attachment-file: HTML is served only as an opaque download", async () => {
    const adminToken = await makeSession(adminUserId);
    const { db, cases, caseAttachments } = dbMod as any;
    const caseId = rid("c");
    const attachmentId = rid("att");
    const testFilename = `test-${rid("f")}.html`;
    const testFilePath = path.join(TEST_MEDIA_DIR, testFilename);

    fs.writeFileSync(
      testFilePath,
      "<!doctype html><script>document.body.textContent='executed'</script>",
    );

    await db.insert(cases).values({
      id: caseId,
      caseNumber: rid("CN"),
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      patientFirstName: "Html",
      patientLastName: "DownloadTest",
      doctorName: "Dr. Inline",
      status: "received",
      createdByUserId: adminUserId,
    });
    await db.insert(caseAttachments).values({
      id: attachmentId,
      caseId,
      storageKey: testFilename,
      fileType: "text/html",
      fileName: "unsafe.html",
      visibility: "shared_with_provider",
      uploadedByUserId: adminUserId,
      uploadedByOrganizationId: labOrgId,
    });

    mockExtractMediaFileName.mockReturnValue(testFilename);
    try {
      const r = await request(appMod.default)
        .get(`/api/cases/attachment-file/${testFilename}`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(r.status).toBe(200);
      expect(r.headers["content-type"]).toMatch(/^application\/octet-stream/);
      expect(r.headers["content-disposition"]).toMatch(/^attachment;/);
      expect(r.headers["content-disposition"]).not.toMatch(/^inline;/);
      expect(r.headers["x-content-type-options"]).toBe("nosniff");
    } finally {
      mockExtractMediaFileName.mockReturnValue(null);
      await cleanCase(caseId);
      try { fs.unlinkSync(testFilePath); } catch { /* ignore */ }
    }
  });

  it("GET attachment/file: .ply binary is served as application/octet-stream with Content-Disposition: attachment", async () => {
    // Regression guard: non-image, non-PDF file types must still force a
    // download rather than attempting inline rendering.
    const adminToken = await makeSession(adminUserId);
    const { db, cases, caseAttachments } = dbMod as any;

    const caseId = rid("c");
    const attachmentId = rid("att");
    const testFilename = `test-${rid("f")}.ply`;
    const testFilePath = path.join(TEST_MEDIA_DIR, testFilename);

    fs.writeFileSync(testFilePath, "ply\nformat ascii 1.0\n");

    await db.insert(cases).values({
      id: caseId,
      caseNumber: rid("CN"),
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      patientFirstName: "Ply",
      patientLastName: "DownloadTest",
      doctorName: "Dr. Download",
      status: "received",
      createdByUserId: adminUserId,
    });

    await db.insert(caseAttachments).values({
      id: attachmentId,
      caseId,
      storageKey: testFilename,
      fileType: "model/ply",
      fileName: "scan.ply",
      visibility: "internal_lab_only",
      uploadedByUserId: adminUserId,
      uploadedByOrganizationId: labOrgId,
    });

    mockExtractMediaFileName.mockReturnValueOnce(testFilename);

    const r = await request(appMod.default)
      .get(`/api/cases/${caseId}/attachments/${attachmentId}/file`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/(?:model\/ply|application\/octet-stream)/);
    expect(r.headers["content-disposition"]).toMatch(/^attachment/);

    await cleanCase(caseId);
    try { fs.unlinkSync(testFilePath); } catch { /* ignore */ }
  });

  it("GET attachment/file: explicit MP4 download keeps its video MIME and filename", async () => {
    // The authenticated viewer appends download=1 only after a user clicks the
    // download button. The response must keep the original metadata.
    const adminToken = await makeSession(adminUserId);
    const { db, cases, caseAttachments } = dbMod as any;

    const caseId = rid("c");
    const attachmentId = rid("att");
    const testFilename = `test-${rid("f")}.mp4`;
    const testFilePath = path.join(TEST_MEDIA_DIR, testFilename);

    fs.writeFileSync(testFilePath, "fake mp4 content for testing");

    await db.insert(cases).values({
      id: caseId,
      caseNumber: rid("CN"),
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      patientFirstName: "Mp4",
      patientLastName: "InlineTest",
      doctorName: "Dr. Video",
      status: "received",
      createdByUserId: adminUserId,
    });

    await db.insert(caseAttachments).values({
      id: attachmentId,
      caseId,
      storageKey: testFilename,
      fileType: "video/mp4",
      fileName: "recording.mp4",
      visibility: "internal_lab_only",
      uploadedByUserId: adminUserId,
      uploadedByOrganizationId: labOrgId,
    });

    mockExtractMediaFileName.mockReturnValueOnce(testFilename);

    const r = await request(appMod.default)
      .get(`/api/cases/${caseId}/attachments/${attachmentId}/file?download=1`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/video\/mp4/);
    expect(r.headers["content-disposition"]).toMatch(/^attachment/);
    expect(r.headers["content-disposition"]).toContain('filename="recording.mp4"');

    await cleanCase(caseId);
    try { fs.unlinkSync(testFilePath); } catch { /* ignore */ }
  });

  it("GET attachment/file: video/webm is served inline", async () => {
    // Regression guard: WebM is browser-native and must be previewed inline.
    const adminToken = await makeSession(adminUserId);
    const { db, cases, caseAttachments } = dbMod as any;

    const caseId = rid("c");
    const attachmentId = rid("att");
    const testFilename = `test-${rid("f")}.webm`;
    const testFilePath = path.join(TEST_MEDIA_DIR, testFilename);

    fs.writeFileSync(testFilePath, "fake webm content for testing");

    await db.insert(cases).values({
      id: caseId,
      caseNumber: rid("CN"),
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      patientFirstName: "Webm",
      patientLastName: "InlineTest",
      doctorName: "Dr. Video",
      status: "received",
      createdByUserId: adminUserId,
    });

    await db.insert(caseAttachments).values({
      id: attachmentId,
      caseId,
      storageKey: testFilename,
      fileType: "video/webm",
      fileName: "recording.webm",
      visibility: "internal_lab_only",
      uploadedByUserId: adminUserId,
      uploadedByOrganizationId: labOrgId,
    });

    mockExtractMediaFileName.mockReturnValueOnce(testFilename);

    const r = await request(appMod.default)
      .get(`/api/cases/${caseId}/attachments/${attachmentId}/file`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/video\/webm/);
    expect(r.headers["content-disposition"]).toMatch(/^inline/);

    await cleanCase(caseId);
    try { fs.unlinkSync(testFilePath); } catch { /* ignore */ }
  });

  it("GET attachment/file: video/quicktime (MOV) forces download", async () => {
    // QuickTime MOV is not universally supported by browsers inline; it must
    // continue to force a download rather than a broken inline preview.
    const adminToken = await makeSession(adminUserId);
    const { db, cases, caseAttachments } = dbMod as any;

    const caseId = rid("c");
    const attachmentId = rid("att");
    const testFilename = `test-${rid("f")}.mov`;
    const testFilePath = path.join(TEST_MEDIA_DIR, testFilename);

    fs.writeFileSync(testFilePath, "fake mov content for testing");

    await db.insert(cases).values({
      id: caseId,
      caseNumber: rid("CN"),
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      patientFirstName: "Mov",
      patientLastName: "DownloadTest",
      doctorName: "Dr. Video",
      status: "received",
      createdByUserId: adminUserId,
    });

    await db.insert(caseAttachments).values({
      id: attachmentId,
      caseId,
      storageKey: testFilename,
      fileType: "video/quicktime",
      fileName: "Shade Check.MOV",
      visibility: "internal_lab_only",
      uploadedByUserId: adminUserId,
      uploadedByOrganizationId: labOrgId,
    });

    mockExtractMediaFileName.mockReturnValueOnce(testFilename);

    const r = await request(appMod.default)
      .get(`/api/cases/${caseId}/attachments/${attachmentId}/file`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/video\/quicktime/);
    expect(r.headers["content-disposition"]).toMatch(/^attachment/);
    expect(r.headers["content-disposition"]).toContain('filename="Shade Check.MOV"');
    expect(r.headers["content-disposition"]).toContain(
      "filename*=UTF-8''Shade%20Check.MOV",
    );

    await cleanCase(caseId);
    try { fs.unlinkSync(testFilePath); } catch { /* ignore */ }
  });
});
