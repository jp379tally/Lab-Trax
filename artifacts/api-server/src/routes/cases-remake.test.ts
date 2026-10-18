/**
 * Regression suite: remake case creation invariants.
 *
 * Protected behaviors:
 *   (1) Remake of a canonical original: 201, caseNumber "originalB",
 *       remakeOfCaseId set, visible in GET /api/cases, invoice created,
 *       AND case_events rows for "remake_of" (new case) and "remade_by"
 *       (original) are written atomically in the same transaction.
 *   (2) Remake of a legacy (lab_cases blob) original: 201, caseNumber
 *       "legacyCaseNumberB", visible in GET /api/cases, invoice created,
 *       lab_cases activityLog updated, NO remakeWarning in the happy-path
 *       response, and a forward case_events "remake_of" row exists on the
 *       new case.
 *   (3) Multiple remakes of the same canonical original get sequential suffix
 *       letters (B → C).
 *   (3b-mobile) POST /cases with X-LabTrax-Client: mobile/2 on a case that
 *        is itself a remake yields C not BB. Pins the root-traversal fix for
 *        the mobile-client code path (remakeOfCaseId in POST /cases body).
 *   (3c) POST /cases/:id/remake on a case that is itself a remake yields the
 *        next suffix from the chain root (C), not a double-suffix (BB). Pins
 *        the root-traversal fix specifically for the :id/remake endpoint used
 *        by the desktop "Mark as remake" button.
 *   (4) No-charge remake: invoice is still created (not skipped), carries a
 *       no-charge note.
 *   (5) case_number unique-constraint violation returns 409 (not 500).
 *
 * PATCH /:caseId/mark-as-remake (Invoice Editor "Mark as remake" action —
 * reachable for any case regardless of AI-import/review status):
 *   (6) Links case as remake, assigns the next suffix, saves all
 *       questionnaire fields on the case row, and writes both the forward
 *       (remake_of) and backward (remade_by) history events plus a
 *       case_remake_linked audit log entry.
 *   (7) A no-charge answer zeros the case's open invoice and its line items.
 *   (8) Rejects a case remaking itself (400).
 *   (9) Rejects a case that is already linked as a remake (400).
 *   (10) Sequential suffix assignment (B taken → next call gets C).
 *   (11) A user with no lab/practice membership on the case gets 403.
 *
 * Failure-semantic guarantees (architectural, enforced by the transaction):
 *   - Canonical cross-link events are written inside the same database
 *     transaction as the case INSERT. If those inserts fail, the entire
 *     transaction rolls back — there is no orphan case and no silent partial
 *     success. The case either fully exists with its events, or it does not
 *     exist at all.
 *   - Legacy blob update failures surface as a "remakeWarning" field in the
 *     201 response body (not silently dropped), so callers can surface a
 *     non-blocking notice to the user.
 *
 * Skipped when DATABASE_URL is not configured.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import request from "supertest";
import * as path from "node:path";
import * as os from "node:os";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(os.tmpdir(), "labtrax-test-media-remake"),
  extractMediaFileName: () => null,
  extractMediaFilenamesFromText: () => [],
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

describe("custom remake reason validation", () => {
  it("accepts and trims a nonblank custom reason", async () => {
    const { validateCustomRemakeReason } = await import("./cases.js");
    expect(validateCustomRemakeReason("other", "  Occlusal interference  ")).toBe(
      "Occlusal interference",
    );
  });

  it("rejects blank custom reasons", async () => {
    const { validateCustomRemakeReason } = await import("./cases.js");
    expect(() => validateCustomRemakeReason("other", " \t ")).toThrow(
      /cannot be blank/i,
    );
  });

  it("rejects custom reasons over the existing 2000-character limit", async () => {
    const { validateCustomRemakeReason } = await import("./cases.js");
    expect(() => validateCustomRemakeReason("other", "x".repeat(2001))).toThrow(
      /at most 2000/i,
    );
  });

  it("does not reinterpret legacy or standard free-text reasons", async () => {
    const { validateCustomRemakeReason } = await import("./cases.js");
    expect(validateCustomRemakeReason("fit_margins", "  legacy label ")).toBe(
      "  legacy label ",
    );
    expect(validateCustomRemakeReason(null, null)).toBeNull();
  });
});

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("Remake case creation invariants (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let authLib: typeof import("../lib/auth.js");

  const labOwnerId = rid("u");
  const labOrgId = rid("lab");
  const providerOrgId = rid("prov");

  const createdCaseIds: string[] = [];
  const createdLabCaseIds: string[] = [];

  async function makeSession(userId: string): Promise<{ access: string }> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const refresh = authLib.signRefreshToken(userId, sessionId);
    const hash = createHash("sha256").update(refresh).digest("hex");
    await db.insert(userSessions).values({ id: sessionId, userId, tokenHash: hash, expiresAt });
    const access = authLib.signAccessToken(userId, sessionId);
    return { access };
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-remake";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    await (await import("./index.js")).labtraxRoutesReady;
    authLib = await import("../lib/auth.js");

    const { db, users, organizations, organizationMemberships } = dbMod as any;

    await db.insert(users).values({
      id: labOwnerId,
      username: `remakeowner_${labOwnerId}`,
      password: "doesnotmatter",
    });

    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: rid("RemakeTestLab") },
      {
        id: providerOrgId,
        type: "provider",
        name: rid("RemakeTestPractice"),
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

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const {
      db,
      auditLogs,
      caseEvents,
      caseNotes,
      invoiceLineItems,
      invoices,
      cases: casesTable,
      labCases: labCasesTable,
      userSessions,
      organizationMemberships,
      organizations,
      users,
      caseRestorations,
    } = dbMod as any;

    if (createdCaseIds.length) {
      if (caseEvents) await db.delete(caseEvents).where(inArray(caseEvents.caseId, createdCaseIds));
      if (caseNotes) await db.delete(caseNotes).where(inArray(caseNotes.caseId, createdCaseIds));
      if (caseRestorations) await db.delete(caseRestorations).where(inArray(caseRestorations.caseId, createdCaseIds));
      const invRows = await db
        .select({ id: invoices.id })
        .from(invoices)
        .where(inArray(invoices.caseId, createdCaseIds));
      const invIds = invRows.map((r: any) => r.id);
      if (invoiceLineItems && invIds.length) {
        await db.delete(invoiceLineItems).where(inArray(invoiceLineItems.invoiceId, invIds));
      }
      await db.delete(invoices).where(inArray(invoices.caseId, createdCaseIds));
      await db.delete(casesTable).where(inArray(casesTable.id, createdCaseIds));
    }

    if (createdLabCaseIds.length && labCasesTable) {
      await db.delete(labCasesTable).where(inArray(labCasesTable.id, createdLabCaseIds));
    }

    await db.delete(auditLogs).where(inArray(auditLogs.organizationId, [labOrgId, providerOrgId]));
    await db.delete(invoices).where(inArray(invoices.labOrganizationId, [labOrgId]));
    await db.delete(casesTable).where(inArray(casesTable.labOrganizationId, [labOrgId]));
    await db.delete(userSessions).where(inArray(userSessions.userId, [labOwnerId]));
    await db.delete(organizationMemberships).where(
      inArray(organizationMemberships.userId, [labOwnerId]),
    );
    await db.delete(organizations).where(eq(organizations.id, providerOrgId));
    await db.delete(organizations).where(eq(organizations.id, labOrgId));
    await db.delete(users).where(inArray(users.id, [labOwnerId]));
  });

  // ── (1) Remake of a canonical original ───────────────────────────────────

  it("(1) canonical remake: 201, suffixed caseNumber (B), visible in list, invoice created, both case_events rows committed atomically", async () => {
    const { access } = await makeSession(labOwnerId);
    const { db, cases: casesTable, invoices, caseEvents } = dbMod as any;

    const originalId = rid("orig");
    const originalNumber = rid("RMK");
    await db.insert(casesTable).values({
      id: originalId,
      caseNumber: originalNumber,
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      status: "received",
      patientFirstName: "Alice",
      patientLastName: "Original",
      doctorName: "Dr. Synthetic063",
      createdByUserId: labOwnerId,
    });
    createdCaseIds.push(originalId);

    const r = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Alice",
        patientLastName: "Original",
        doctorName: "Dr. Synthetic063",
        status: "received",
        remakeOfCaseId: originalId,
        remakeReason: "Crown fracture",
        remakeCharged: true,
      });

    expect(r.status, `expected 201 but got ${r.status}: ${JSON.stringify(r.body)}`).toBe(201);
    const remake = r.body.data;
    createdCaseIds.push(remake.id);

    // No silent partial success — canonical path must NOT include remakeWarning.
    expect(remake.remakeWarning, "canonical remake must not include a remakeWarning").toBeUndefined();

    expect(remake.caseNumber).toBe(`${originalNumber}B`);
    expect(remake.remakeOfCaseId).toBe(originalId);

    // Visible in GET /api/cases.
    const list = await request(appMod.default)
      .get("/api/cases")
      .set("Authorization", `Bearer ${access}`);
    expect(list.status).toBe(200);
    const casesArr: any[] = list.body.data ?? list.body;
    const found = casesArr.find((c: any) => c.id === remake.id);
    expect(found, "remake case must appear in GET /api/cases").toBeDefined();
    expect(found.caseNumber).toBe(`${originalNumber}B`);

    // Invoice created.
    let invoice: any;
    for (let i = 0; i < 20; i++) {
      await new Promise((res) => setTimeout(res, 100));
      [invoice] = await db
        .select()
        .from(invoices)
        .where(eq(invoices.caseId, remake.id));
      if (invoice) break;
    }
    expect(invoice, "auto-invoice must be created for the remake case").toBeDefined();
    expect(invoice.caseId).toBe(remake.id);
    expect(invoice.labOrganizationId).toBe(labOrgId);
    expect(invoice.providerOrganizationId).toBe(providerOrgId);
    expect(invoice.status).toBe("open");

    // ── Atomic cross-link guarantee ──────────────────────────────────────
    // Both "remake_of" (on the new case) and "remade_by" (on the original)
    // are written inside the same DB transaction as the case INSERT.
    // If either had failed, the whole case creation would have rolled back —
    // so verifying their existence here confirms the atomic guarantee held.
    const forwardEvent = await db.query.caseEvents.findFirst({
      where: and(
        eq(caseEvents.caseId, remake.id),
        eq(caseEvents.eventType, "remake_of"),
      ),
    });
    expect(forwardEvent, "remake_of event must exist on the new case").toBeDefined();
    expect(forwardEvent.metadataJson?.originalCaseId).toBe(originalId);
    expect(forwardEvent.metadataJson?.remakeReason).toBe("Crown fracture");

    const backwardEvent = await db.query.caseEvents.findFirst({
      where: and(
        eq(caseEvents.caseId, originalId),
        eq(caseEvents.eventType, "remade_by"),
      ),
    });
    expect(backwardEvent, "remade_by event must exist on the original case").toBeDefined();
    expect(backwardEvent.metadataJson?.remakeCaseId).toBe(remake.id);
    expect(backwardEvent.metadataJson?.remakeCaseNumber).toBe(`${originalNumber}B`);
  });

  // ── (2) Remake of a legacy (lab_cases blob) original ─────────────────────

  it("(2) legacy remake: 201, suffixed caseNumber, visible in list, invoice created, activityLog updated, no remakeWarning in happy path, forward case_events committed", async () => {
    const { access } = await makeSession(labOwnerId);
    const { db, labCases: labCasesTable, invoices, caseEvents } = dbMod as any;

    const doctorName = "Dr. Legacy";
    const legacyCaseNumber = rid("LGC");
    const legacyCaseId = rid("lc");
    createdLabCaseIds.push(legacyCaseId);

    await db.insert(labCasesTable).values({
      id: legacyCaseId,
      ownerId: labOwnerId,
      organizationId: labOrgId,
      caseData: JSON.stringify({
        caseNumber: legacyCaseNumber,
        doctorName,
        patientName: "Bob Patient",
      }),
    });

    const r = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Bob",
        patientLastName: "Patient",
        doctorName,
        status: "received",
        remakeOfCaseId: legacyCaseId,
        remakeReason: "Material failure",
        remakeCharged: true,
      });

    expect(r.status, `expected 201 but got ${r.status}: ${JSON.stringify(r.body)}`).toBe(201);
    const remake = r.body.data;
    createdCaseIds.push(remake.id);

    // Happy-path legacy remake must NOT include a remakeWarning.
    // A warning would mean the activityLog blob update failed silently
    // and the server surfaced it explicitly — which is correct behavior
    // for a failure case but must not appear when the update succeeds.
    expect(remake.remakeWarning, "happy-path legacy remake must not include remakeWarning").toBeUndefined();

    expect(remake.caseNumber).toBe(`${legacyCaseNumber}B`);
    expect(remake.remakeOfCaseId).toBe(legacyCaseId);

    // Visible in GET /api/cases.
    const list = await request(appMod.default)
      .get("/api/cases")
      .set("Authorization", `Bearer ${access}`);
    expect(list.status).toBe(200);
    const casesArr: any[] = list.body.data ?? list.body;
    const found = casesArr.find((c: any) => c.id === remake.id);
    expect(found, "legacy-original remake must appear in GET /api/cases").toBeDefined();
    expect(found.caseNumber).toBe(`${legacyCaseNumber}B`);

    // Invoice created.
    let invoice: any;
    for (let i = 0; i < 20; i++) {
      await new Promise((res) => setTimeout(res, 100));
      [invoice] = await db
        .select()
        .from(invoices)
        .where(eq(invoices.caseId, remake.id));
      if (invoice) break;
    }
    expect(invoice, "auto-invoice must be created for the legacy-original remake").toBeDefined();
    expect(invoice.caseId).toBe(remake.id);

    // Forward case_events row committed atomically in the transaction.
    const forwardEvent = await db.query.caseEvents.findFirst({
      where: and(
        eq(caseEvents.caseId, remake.id),
        eq(caseEvents.eventType, "remake_of"),
      ),
    });
    expect(forwardEvent, "remake_of event must exist on the new case even for legacy originals").toBeDefined();
    expect(forwardEvent.metadataJson?.originalCaseId).toBe(legacyCaseId);
    expect(forwardEvent.metadataJson?.originalCaseKind).toBe("legacy");

    // The legacy lab_cases row's activityLog must have a "remade_by" entry.
    // The blob update runs synchronously before the 201 response (not fire-and-forget),
    // so no polling delay is needed in the happy path.
    const [row] = await db
      .select()
      .from(labCasesTable)
      .where(eq(labCasesTable.id, legacyCaseId));
    const parsed = typeof row.caseData === "string" ? JSON.parse(row.caseData) : row.caseData;
    expect(Array.isArray(parsed?.activityLog), "lab_cases activityLog must be an array").toBe(true);
    const remadeByEntry = parsed.activityLog.find((e: any) => e.type === "remade_by");
    expect(remadeByEntry, "activityLog must contain a remade_by entry").toBeDefined();
    expect(remadeByEntry.metadata?.remakeCaseId).toBe(remake.id);
  });

  it("(2b) standard remake endpoint links an iTero-imported case without clearing its review flag", async () => {
    const { access } = await makeSession(labOwnerId);
    const { db, cases: casesTable } = dbMod as any;
    const originalId = rid("iteroReview");
    const originalNumber = rid("ITR");

    await db.insert(casesTable).values({
      id: originalId,
      caseNumber: originalNumber,
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      status: "received",
      patientFirstName: "Imported",
      patientLastName: "Patient",
      doctorName: "Dr. Imported",
      createdByUserId: labOwnerId,
      needsAiReview: true,
      aiImportSource: "itero",
    });
    createdCaseIds.push(originalId);

    const r = await request(appMod.default)
      .post(`/api/cases/${originalId}/remake`)
      .set("Authorization", `Bearer ${access}`)
      .send({
        remakeReasonKey: "fit_margins",
        remakeReason: "Didn't fit — margins",
        remakeCharged: true,
      });

    expect(r.status, `expected 201 but got ${r.status}: ${JSON.stringify(r.body)}`).toBe(201);
    const remakeId = r.body.data.id as string;
    createdCaseIds.push(remakeId);

    const [original] = await db
      .select({
        needsAiReview: casesTable.needsAiReview,
        aiImportSource: casesTable.aiImportSource,
      })
      .from(casesTable)
      .where(eq(casesTable.id, originalId));
    expect(original).toEqual({ needsAiReview: true, aiImportSource: "itero" });

    const [remake] = await db
      .select({
        caseNumber: casesTable.caseNumber,
        remakeOfCaseId: casesTable.remakeOfCaseId,
        needsAiReview: casesTable.needsAiReview,
        aiImportSource: casesTable.aiImportSource,
      })
      .from(casesTable)
      .where(eq(casesTable.id, remakeId));
    expect(remake).toMatchObject({
      caseNumber: `${originalNumber}B`,
      remakeOfCaseId: originalId,
      needsAiReview: false,
      aiImportSource: null,
    });
  });

  // ── (3) Multiple remakes get sequential suffix letters ───────────────────

  it("(3) two remakes of same canonical original get suffix B then C", async () => {
    const { access } = await makeSession(labOwnerId);
    const { db, cases: casesTable } = dbMod as any;

    const originalId = rid("orig2");
    const originalNumber = rid("RMK2");
    await db.insert(casesTable).values({
      id: originalId,
      caseNumber: originalNumber,
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      status: "received",
      patientFirstName: "Carol",
      patientLastName: "Multi",
      doctorName: "Dr. Multi",
      createdByUserId: labOwnerId,
    });
    createdCaseIds.push(originalId);

    const payload = {
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      patientFirstName: "Carol",
      patientLastName: "Multi",
      doctorName: "Dr. Multi",
      status: "received",
      remakeOfCaseId: originalId,
      remakeReason: "First remake",
      remakeCharged: true,
    };

    const r1 = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send(payload);
    expect(r1.status).toBe(201);
    createdCaseIds.push(r1.body.data.id);
    expect(r1.body.data.caseNumber).toBe(`${originalNumber}B`);

    const r2 = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({ ...payload, remakeReason: "Second remake" });
    expect(r2.status).toBe(201);
    createdCaseIds.push(r2.body.data.id);
    expect(r2.body.data.caseNumber).toBe(`${originalNumber}C`);
  });

  // ── (3b) Remake of a remake gets C, not BB ───────────────────────────────
  //
  // This is the canonical regression test for the root-traversal fix.
  // When "26-334B" is itself remade, the server must resolve the root
  // ("26-334"), count ALL descendants (1: the existing "B"), and produce
  // "26-334C" — NOT "26-334BB".

  it("(3b) remake of a remake gets suffix C (not BB) — root traversal regression", async () => {
    const { access } = await makeSession(labOwnerId);
    const { db, cases: casesTable } = dbMod as any;

    // Seed the root original.
    const rootId = rid("root3b");
    const rootNumber = rid("ROOT");
    await db.insert(casesTable).values({
      id: rootId,
      caseNumber: rootNumber,
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      status: "received",
      patientFirstName: "Root",
      patientLastName: "Patient",
      doctorName: "Dr. Root",
      createdByUserId: labOwnerId,
    });
    createdCaseIds.push(rootId);

    // First remake of root → should be "ROOTB".
    const r1 = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Root",
        patientLastName: "Patient",
        doctorName: "Dr. Root",
        status: "received",
        remakeOfCaseId: rootId,
        remakeReason: "First remake",
        remakeCharged: true,
      });
    expect(r1.status).toBe(201);
    const remakeBId = r1.body.data.id as string;
    createdCaseIds.push(remakeBId);
    expect(r1.body.data.caseNumber).toBe(`${rootNumber}B`);

    // Remake of the remake ("ROOTB") → must produce "ROOTC", not "ROOTBB".
    const r2 = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Root",
        patientLastName: "Patient",
        doctorName: "Dr. Root",
        status: "received",
        remakeOfCaseId: remakeBId,
        remakeReason: "Remake of the remake",
        remakeCharged: true,
      });
    expect(r2.status, `expected 201 but got ${r2.status}: ${JSON.stringify(r2.body)}`).toBe(201);
    const remakeCId = r2.body.data.id as string;
    createdCaseIds.push(remakeCId);

    expect(
      r2.body.data.caseNumber,
      `remaking "${rootNumber}B" must produce "${rootNumber}C", not "${rootNumber}BB"`,
    ).toBe(`${rootNumber}C`);

    // Third level: remake the root again → must get "D".
    const r3 = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Root",
        patientLastName: "Patient",
        doctorName: "Dr. Root",
        status: "received",
        remakeOfCaseId: rootId,
        remakeReason: "Third remake of root",
        remakeCharged: true,
      });
    expect(r3.status).toBe(201);
    createdCaseIds.push(r3.body.data.id);
    expect(r3.body.data.caseNumber).toBe(`${rootNumber}D`);
  });

  // ── (3b-mobile) Mobile client remake-of-a-remake gets C, not BB ─────────
  //
  // The mobile app creates remakes via POST /cases with remakeOfCaseId in the
  // body, sending X-LabTrax-Client: mobile/2.  This test fires that exact
  // request starting from a "B" case and pins that the returned caseNumber is
  // "C" not "BB".  A client-side field-mapping regression (e.g. sending
  // the wrong id as remakeOfCaseId) would be caught here independently of the
  // server-only (3b) test which does not exercise the mobile header path.

  it("(3b-mobile) POST /cases with mobile/2 header: remake of a remake gets suffix C (not BB)", async () => {
    const { access } = await makeSession(labOwnerId);
    const { db, cases: casesTable } = dbMod as any;

    // Seed the chain root directly in the DB.
    const rootId = rid("root3bm");
    const rootNumber = rid("MOB");
    await db.insert(casesTable).values({
      id: rootId,
      caseNumber: rootNumber,
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      status: "received",
      patientFirstName: "Mobile",
      patientLastName: "Root",
      doctorName: "Dr. Mobile",
      createdByUserId: labOwnerId,
    });
    createdCaseIds.push(rootId);

    // Seed the first remake ("B") directly in the DB so the setup does not
    // depend on POST /cases itself.
    const remakeBId = rid("remB3bm");
    await db.insert(casesTable).values({
      id: remakeBId,
      caseNumber: `${rootNumber}B`,
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      status: "received",
      patientFirstName: "Mobile",
      patientLastName: "Root",
      doctorName: "Dr. Mobile",
      createdByUserId: labOwnerId,
      remakeOfCaseId: rootId,
      remakeReason: "First remake (seeded for mobile test)",
    });
    createdCaseIds.push(remakeBId);

    // Fire the request exactly as the mobile client would:
    //   POST /api/cases
    //   X-LabTrax-Client: mobile/2
    //   body: { ..., remakeOfCaseId: <the B case id> }
    //
    // The server must traverse the chain root (rootId), count all existing
    // descendants (1: the "B" case already seeded), and produce "C" — NOT "BB".
    const r = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .set("x-labtrax-client", "mobile/2")
      .send({
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Mobile",
        patientLastName: "Root",
        doctorName: "Dr. Mobile",
        status: "received",
        remakeOfCaseId: remakeBId,
        remakeReason: "Remake of the B remake via mobile client",
        remakeCharged: true,
      });

    expect(
      r.status,
      `expected 201 but got ${r.status}: ${JSON.stringify(r.body)}`,
    ).toBe(201);
    const remakeC = r.body.data;
    createdCaseIds.push(remakeC.id);

    expect(
      remakeC.caseNumber,
      `mobile client remaking "${rootNumber}B" must produce "${rootNumber}C", not "${rootNumber}BB"`,
    ).toBe(`${rootNumber}C`);

    // remakeOfCaseId must point to the immediate parent (the B case),
    // not the root — the root-traversal is server-side number computation only.
    expect(remakeC.remakeOfCaseId).toBe(remakeBId);
  });

  // ── (3c) :id/remake endpoint — remake-of-a-remake gets C, not BB ──────────
  //
  // The desktop "Mark as remake" button calls POST /cases/:id/remake (not
  // POST /cases).  This code path independently resolves the remake chain root
  // before computing the suffix letter.  If that traversal were missing,
  // remaking "26-334B" via the button would produce "26-334BB" instead of
  // "26-334C".  This test pins that contract specifically for the :id/remake
  // endpoint so a regression in that handler is caught independently of the
  // POST /cases path covered by (3b).

  it("(3c) POST /cases/:id/remake on a remake case yields C not BB — :id/remake endpoint regression", async () => {
    const { access } = await makeSession(labOwnerId);
    const { db, cases: casesTable } = dbMod as any;

    // Seed the root original directly in the DB.
    const rootId = rid("root3c");
    const rootNumber = rid("EP");
    await db.insert(casesTable).values({
      id: rootId,
      caseNumber: rootNumber,
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      status: "received",
      patientFirstName: "Endpoint",
      patientLastName: "Patient",
      doctorName: "Dr. Endpoint",
      createdByUserId: labOwnerId,
    });
    createdCaseIds.push(rootId);

    // Seed the first remake ("B") directly in the DB so we don't rely on the
    // POST /cases path for setup.
    const remakeBId = rid("remB3c");
    await db.insert(casesTable).values({
      id: remakeBId,
      caseNumber: `${rootNumber}B`,
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      status: "received",
      patientFirstName: "Endpoint",
      patientLastName: "Patient",
      doctorName: "Dr. Endpoint",
      createdByUserId: labOwnerId,
      remakeOfCaseId: rootId,
      remakeReason: "First remake (seeded)",
    });
    createdCaseIds.push(remakeBId);

    // Call POST /cases/:id/remake on the "B" case via the desktop-button endpoint.
    // The body uses the remake questionnaire schema (remakeReasonKey is required).
    const r = await request(appMod.default)
      .post(`/api/cases/${remakeBId}/remake`)
      .set("Authorization", `Bearer ${access}`)
      .send({
        remakeReasonKey: "fit_margins",
        remakeReason: "Remake of the B remake via :id/remake endpoint",
        remakeCharged: true,
      });

    expect(
      r.status,
      `expected 201 but got ${r.status}: ${JSON.stringify(r.body)}`,
    ).toBe(201);
    const remakeC = r.body.data;
    createdCaseIds.push(remakeC.id);

    expect(
      remakeC.caseNumber,
      `remaking "${rootNumber}B" via POST /cases/:id/remake must produce "${rootNumber}C", not "${rootNumber}BB"`,
    ).toBe(`${rootNumber}C`);

    // The :id/remake endpoint returns { id, caseNumber } only, so we verify
    // the DB row directly to confirm remakeOfCaseId points to the immediate
    // parent (the "B" case) rather than the root.
    const [dbRow] = await db
      .select({ remakeOfCaseId: casesTable.remakeOfCaseId })
      .from(casesTable)
      .where(eq(casesTable.id, remakeC.id));
    expect(dbRow?.remakeOfCaseId).toBe(remakeBId);
  });

  // ── (3d) :id/remake mid-transaction failure rolls back everything ─────────
  //
  // POST /cases/:id/remake now inserts the new case and links it (suffix
  // assignment, remake_of/remade_by events, invoice zeroing) in ONE
  // transaction via the shared linkCaseAsRemakeCore. A failure that occurs
  // AFTER the new case row is inserted (here: the 24-remake limit check,
  // which throws inside the transaction) must roll back the whole bundle —
  // no orphan placeholder case, no dangling remade_by event on the original.

  it("(3d) POST /cases/:id/remake failing mid-transaction leaves no orphan case and no remade_by event", async () => {
    const { access } = await makeSession(labOwnerId);
    const { db, cases: casesTable, caseEvents } = dbMod as any;

    const rootId = rid("root3d");
    const rootNumber = rid("FL");
    await db.insert(casesTable).values({
      id: rootId,
      caseNumber: rootNumber,
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      status: "received",
      patientFirstName: "Rollback",
      patientLastName: "Patient",
      doctorName: "Dr. Rollback",
      createdByUserId: labOwnerId,
    });
    createdCaseIds.push(rootId);

    // Seed 24 direct remakes so the next remake exceeds the maximum and the
    // limit check throws inside the transaction (after the placeholder case
    // insert).
    for (let i = 0; i < 24; i++) {
      const id = rid(`rb3d${i}`);
      await db.insert(casesTable).values({
        id,
        caseNumber: `${rootNumber}${String.fromCharCode(66 + i)}`,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        status: "received",
        patientFirstName: "Rollback",
        patientLastName: "Patient",
        doctorName: "Dr. Rollback",
        createdByUserId: labOwnerId,
        remakeOfCaseId: rootId,
        remakeReason: "seeded",
      });
      createdCaseIds.push(id);
    }

    const r = await request(appMod.default)
      .post(`/api/cases/${rootId}/remake`)
      .set("Authorization", `Bearer ${access}`)
      .send({
        remakeReasonKey: "fit_margins",
        remakeReason: "Should exceed the remake limit and roll back",
        remakeCharged: true,
      });
    expect(
      r.status,
      `expected 409 but got ${r.status}: ${JSON.stringify(r.body)}`,
    ).toBe(409);

    // No orphan placeholder case may survive the rollback.
    const orphans = await db
      .select({ id: casesTable.id })
      .from(casesTable)
      .where(
        and(
          eq(casesTable.labOrganizationId, labOrgId),
          sql`${casesTable.caseNumber} LIKE 'RMK-PENDING-%'`,
        ),
      );
    expect(
      orphans,
      "a failed remake must not leave an orphan RMK-PENDING case behind",
    ).toEqual([]);

    // No dangling remade_by event on the original.
    const [remadeBy] = await db
      .select()
      .from(caseEvents)
      .where(
        and(
          eq(caseEvents.caseId, rootId),
          eq(caseEvents.eventType, "remade_by"),
        ),
      );
    expect(
      remadeBy,
      "a failed remake must not leave a remade_by event on the original",
    ).toBeUndefined();
  });

  // ── (4) No-charge remake: invoice still created ───────────────────────────

  it("(4) no-charge remake (remakeCharged: false) still creates an invoice with a no-charge note", async () => {
    const { access } = await makeSession(labOwnerId);
    const { db, cases: casesTable, invoices } = dbMod as any;

    const originalId = rid("orig3");
    const originalNumber = rid("NC");
    await db.insert(casesTable).values({
      id: originalId,
      caseNumber: originalNumber,
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      status: "received",
      patientFirstName: "Dave",
      patientLastName: "NoCharge",
      doctorName: "Dr. NoCharge",
      createdByUserId: labOwnerId,
    });
    createdCaseIds.push(originalId);

    const r = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Dave",
        patientLastName: "NoCharge",
        doctorName: "Dr. NoCharge",
        status: "received",
        remakeOfCaseId: originalId,
        remakeReason: "Lab fault",
        remakeCharged: false,
      });

    expect(r.status, `expected 201 but got ${r.status}: ${JSON.stringify(r.body)}`).toBe(201);
    const remake = r.body.data;
    createdCaseIds.push(remake.id);
    expect(remake.caseNumber).toBe(`${originalNumber}B`);

    let invoice: any;
    for (let i = 0; i < 20; i++) {
      await new Promise((res) => setTimeout(res, 100));
      [invoice] = await db
        .select()
        .from(invoices)
        .where(eq(invoices.caseId, remake.id));
      if (invoice) break;
    }
    expect(invoice, "no-charge remake must still have an auto-generated invoice").toBeDefined();
    expect(invoice.caseId).toBe(remake.id);
    expect(typeof invoice.notes === "string" && invoice.notes.length > 0,
      "no-charge remake invoice must carry a no-charge note").toBe(true);
  });

  // ── (5b) Remake visible in the provider-scoped (practice-account) list ───

  it("(5b) canonical remake appears in GET /api/cases?providerOrganizationId=... (Customer Center / practice-account view)", async () => {
    const { access } = await makeSession(labOwnerId);
    const { db, cases: casesTable } = dbMod as any;

    const originalId = rid("origPC");
    const originalNumber = rid("PCV");
    await db.insert(casesTable).values({
      id: originalId,
      caseNumber: originalNumber,
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      status: "received",
      patientFirstName: "Pam",
      patientLastName: "Center",
      doctorName: "Dr. Center",
      createdByUserId: labOwnerId,
    });
    createdCaseIds.push(originalId);

    const r = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Pam",
        patientLastName: "Center",
        doctorName: "Dr. Center",
        status: "received",
        remakeOfCaseId: originalId,
        remakeReason: "Customer Center visibility",
        remakeCharged: true,
      });

    expect(r.status, `expected 201 but got ${r.status}: ${JSON.stringify(r.body)}`).toBe(201);
    const remake = r.body.data;
    createdCaseIds.push(remake.id);
    expect(remake.caseNumber).toBe(`${originalNumber}B`);

    // The Customer Center and the provider's practice-account case lists query
    // /api/cases scoped to a specific providerOrganizationId. The remake case
    // must surface in that scoped result so those views update without a manual
    // page reload (the React Query ["cases"] invalidation in DashboardDropZone
    // refetches exactly this request).
    const scoped = await request(appMod.default)
      .get(
        `/api/cases?labOrganizationId=${encodeURIComponent(labOrgId)}&providerOrganizationId=${encodeURIComponent(providerOrgId)}`,
      )
      .set("Authorization", `Bearer ${access}`);
    expect(scoped.status).toBe(200);
    const scopedArr: any[] = scoped.body.data ?? scoped.body;
    const foundScoped = scopedArr.find((c: any) => c.id === remake.id);
    expect(
      foundScoped,
      "remake case must appear in the provider-scoped GET /api/cases used by Customer Center / practice-account views",
    ).toBeDefined();
    expect(foundScoped.caseNumber).toBe(`${originalNumber}B`);
    expect(foundScoped.providerOrganizationId).toBe(providerOrgId);
  });

  // ── (5) Duplicate suffix → 409 not 500 ──────────────────────────────────

  it("(5) case-number unique-constraint collision returns 409 (not 500)", async () => {
    const { access } = await makeSession(labOwnerId);
    const { db, cases: casesTable } = dbMod as any;

    const originalId = rid("orig4");
    const originalNumber = rid("COL");
    await db.insert(casesTable).values({
      id: originalId,
      caseNumber: originalNumber,
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      status: "received",
      patientFirstName: "Eve",
      patientLastName: "Collision",
      doctorName: "Dr. Collision",
      createdByUserId: labOwnerId,
    });
    createdCaseIds.push(originalId);

    // Pre-occupy the "B" suffix slot — the server counts 0 existing remakes,
    // computes suffix "B", then hits the unique index.
    const takenId = rid("taken");
    await db.insert(casesTable).values({
      id: takenId,
      caseNumber: `${originalNumber}B`,
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      status: "received",
      patientFirstName: "Eve",
      patientLastName: "Collision",
      doctorName: "Dr. Collision",
      createdByUserId: labOwnerId,
    });
    createdCaseIds.push(takenId);

    const r = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Eve",
        patientLastName: "Collision",
        doctorName: "Dr. Collision",
        status: "received",
        remakeOfCaseId: originalId,
        remakeReason: "Collision test",
        remakeCharged: true,
      });

    expect(
      r.status,
      `expected 409 for case-number collision but got ${r.status}: ${JSON.stringify(r.body)}`,
    ).toBe(409);

    // The message must be user-readable (not a raw pg error).
    expect(typeof r.body.message === "string" && r.body.message.length > 10,
      "409 must include a human-readable message").toBe(true);
  });

  // ── PATCH /:caseId/mark-as-remake (Invoice Editor "Mark as remake") ──────
  //
  // Exercises the same linkExistingCaseAsRemake capability as POST /cases and
  // POST /:id/remake above, but through the new standalone endpoint that is
  // reachable for ANY case regardless of AI-import/review status — the
  // capability the Invoice Editor's "Mark as remake" action calls.

  it("(6) PATCH /:caseId/mark-as-remake: links case as remake, assigns suffix, saves questionnaire fields, writes both history events + audit log", async () => {
    const { access } = await makeSession(labOwnerId);
    const { db, cases: casesTable, caseEvents, auditLogs } = dbMod as any;

    const originalId = rid("origMR");
    const originalNumber = rid("MR");
    await db.insert(casesTable).values({
      id: originalId,
      caseNumber: originalNumber,
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      status: "received",
      patientFirstName: "Frank",
      patientLastName: "Reviewed",
      doctorName: "Dr. Reviewed",
      createdByUserId: labOwnerId,
    });
    createdCaseIds.push(originalId);

    const reviewedCaseId = rid("reviewed");
    await db.insert(casesTable).values({
      id: reviewedCaseId,
      caseNumber: rid("INV"),
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      status: "received",
      patientFirstName: "Frank",
      patientLastName: "Reviewed",
      doctorName: "Dr. Reviewed",
      createdByUserId: labOwnerId,
    });
    createdCaseIds.push(reviewedCaseId);

    const r = await request(appMod.default)
      .patch(`/api/cases/${reviewedCaseId}/mark-as-remake`)
      .set("Authorization", `Bearer ${access}`)
      .send({
        remakeOfCaseId: originalId,
        remakeReason: "Shade mismatch found during invoice review",
        remakeCharged: true,
        remakeReasonKey: "shade_wrong",
        remakeShadeLightness: "light",
        remakeShadePrescribed: "A2",
        remakeShadeProvided: "A3",
        remakeReturnedToLab: true,
        remakeNotes: "Caught during monthly $0-balance invoice review.",
      });

    expect(r.status, `expected 200 but got ${r.status}: ${JSON.stringify(r.body)}`).toBe(200);
    const expectedCaseNumber = `${originalNumber}B`;
    expect(r.body.data.caseId).toBe(reviewedCaseId);
    expect(r.body.data.caseNumber).toBe(expectedCaseNumber);
    expect(r.body.data.remakeOfCaseId).toBe(originalId);
    expect(r.body.data.remakeReason).toBe("Shade mismatch found during invoice review");
    expect(r.body.data.remakeCharged).toBe(true);
    expect(r.body.data.originalCaseId).toBe(originalId);
    expect(r.body.data.originalCaseNumber).toBe(originalNumber);

    // Questionnaire fields persisted on the case row itself.
    const [updatedRow] = await db
      .select()
      .from(casesTable)
      .where(eq(casesTable.id, reviewedCaseId));
    expect(updatedRow.remakeReasonKey).toBe("shade_wrong");
    expect(updatedRow.remakeShadeLightness).toBe("light");
    expect(updatedRow.remakeShadePrescribed).toBe("A2");
    expect(updatedRow.remakeShadeProvided).toBe("A3");
    expect(updatedRow.remakeReturnedToLab).toBe(true);
    expect(updatedRow.remakeNotes).toBe("Caught during monthly $0-balance invoice review.");

    // Forward + backward history events, both using the post-suffix number.
    const forwardEvent = await db.query.caseEvents.findFirst({
      where: and(eq(caseEvents.caseId, reviewedCaseId), eq(caseEvents.eventType, "remake_of")),
    });
    expect(forwardEvent, "remake_of event must exist on the reviewed case").toBeDefined();
    expect(forwardEvent.metadataJson?.originalCaseId).toBe(originalId);

    const backwardEvent = await db.query.caseEvents.findFirst({
      where: and(eq(caseEvents.caseId, originalId), eq(caseEvents.eventType, "remade_by")),
    });
    expect(backwardEvent, "remade_by event must exist on the original case").toBeDefined();
    expect(backwardEvent.metadataJson?.remakeCaseId).toBe(reviewedCaseId);
    expect(backwardEvent.metadataJson?.remakeCaseNumber).toBe(expectedCaseNumber);

    // Audit log entry for the link action.
    const auditRow = await db.query.auditLogs.findFirst({
      where: and(
        eq(auditLogs.entityType, "case"),
        eq(auditLogs.entityId, reviewedCaseId),
        eq(auditLogs.action, "case_remake_linked"),
      ),
    });
    expect(auditRow, "case_remake_linked audit log entry must be written").toBeDefined();
  });

  it("(7) PATCH /:caseId/mark-as-remake: no-charge zeros the case's open invoice and its line items", async () => {
    const { access } = await makeSession(labOwnerId);
    const { db, cases: casesTable, invoices, invoiceLineItems } = dbMod as any;

    const originalId = rid("origNC2");
    const originalNumber = rid("MRNC");
    await db.insert(casesTable).values({
      id: originalId,
      caseNumber: originalNumber,
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      status: "received",
      patientFirstName: "Gina",
      patientLastName: "NoCharge",
      doctorName: "Dr. NoCharge",
      createdByUserId: labOwnerId,
    });
    createdCaseIds.push(originalId);

    const reviewedCaseId = rid("reviewedNC");
    await db.insert(casesTable).values({
      id: reviewedCaseId,
      caseNumber: rid("INV2"),
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      status: "received",
      patientFirstName: "Gina",
      patientLastName: "NoCharge",
      doctorName: "Dr. NoCharge",
      createdByUserId: labOwnerId,
    });
    createdCaseIds.push(reviewedCaseId);

    const invoiceId = rid("inv");
    await db.insert(invoices).values({
      id: invoiceId,
      invoiceNumber: rid("INVNUM"),
      caseId: reviewedCaseId,
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      status: "open",
      subtotal: "150.00",
      total: "150.00",
      balanceDue: "150.00",
      createdByUserId: labOwnerId,
    });
    const lineItemId = rid("li");
    await db.insert(invoiceLineItems).values({
      id: lineItemId,
      invoiceId,
      description: "Zirconia Crown",
      quantity: 1,
      unitPrice: "150.00",
      lineTotal: "150.00",
    });

    const r = await request(appMod.default)
      .patch(`/api/cases/${reviewedCaseId}/mark-as-remake`)
      .set("Authorization", `Bearer ${access}`)
      .send({
        remakeOfCaseId: originalId,
        remakeReason: "Lab error, no charge to practice",
        remakeCharged: false,
      });

    expect(r.status, `expected 200 but got ${r.status}: ${JSON.stringify(r.body)}`).toBe(200);
    expect(r.body.data.remakeCharged).toBe(false);

    const [zeroedInvoice] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
    expect(Number(zeroedInvoice.subtotal)).toBe(0);
    expect(Number(zeroedInvoice.total)).toBe(0);
    expect(Number(zeroedInvoice.balanceDue)).toBe(0);
    expect(typeof zeroedInvoice.notes === "string" && zeroedInvoice.notes.length > 0).toBe(true);

    const [zeroedLine] = await db
      .select()
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.id, lineItemId));
    expect(Number(zeroedLine.unitPrice)).toBe(0);
    expect(Number(zeroedLine.lineTotal)).toBe(0);

    await db.delete(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, invoiceId));
    await db.delete(invoices).where(eq(invoices.id, invoiceId));
  });

  it("(8) PATCH /:caseId/mark-as-remake: rejects a case marked as a remake of itself (400)", async () => {
    const { access } = await makeSession(labOwnerId);
    const { db, cases: casesTable } = dbMod as any;

    const caseId = rid("selfRemake");
    await db.insert(casesTable).values({
      id: caseId,
      caseNumber: rid("SELF"),
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      status: "received",
      patientFirstName: "Hank",
      patientLastName: "Self",
      doctorName: "Dr. Self",
      createdByUserId: labOwnerId,
    });
    createdCaseIds.push(caseId);

    const r = await request(appMod.default)
      .patch(`/api/cases/${caseId}/mark-as-remake`)
      .set("Authorization", `Bearer ${access}`)
      .send({
        remakeOfCaseId: caseId,
        remakeReason: "Should be rejected",
        remakeCharged: true,
      });

    expect(r.status, `expected 400 but got ${r.status}: ${JSON.stringify(r.body)}`).toBe(400);
  });

  it("(9) PATCH /:caseId/mark-as-remake: rejects a case that is already linked as a remake (400)", async () => {
    const { access } = await makeSession(labOwnerId);
    const { db, cases: casesTable } = dbMod as any;

    const originalId = rid("origAlready");
    await db.insert(casesTable).values({
      id: originalId,
      caseNumber: rid("ALR"),
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      status: "received",
      patientFirstName: "Ivy",
      patientLastName: "Already",
      doctorName: "Dr. Already",
      createdByUserId: labOwnerId,
    });
    createdCaseIds.push(originalId);

    const otherOriginalId = rid("origOther");
    await db.insert(casesTable).values({
      id: otherOriginalId,
      caseNumber: rid("OTH"),
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      status: "received",
      patientFirstName: "Ivy",
      patientLastName: "Already",
      doctorName: "Dr. Already",
      createdByUserId: labOwnerId,
    });
    createdCaseIds.push(otherOriginalId);

    const alreadyRemakeId = rid("alreadyRemake");
    await db.insert(casesTable).values({
      id: alreadyRemakeId,
      caseNumber: rid("ALRB"),
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      status: "received",
      patientFirstName: "Ivy",
      patientLastName: "Already",
      doctorName: "Dr. Already",
      createdByUserId: labOwnerId,
      remakeOfCaseId: originalId,
      remakeReason: "Already a remake",
    });
    createdCaseIds.push(alreadyRemakeId);

    const r = await request(appMod.default)
      .patch(`/api/cases/${alreadyRemakeId}/mark-as-remake`)
      .set("Authorization", `Bearer ${access}`)
      .send({
        remakeOfCaseId: otherOriginalId,
        remakeReason: "Trying to relink",
        remakeCharged: true,
      });

    expect(r.status, `expected 400 but got ${r.status}: ${JSON.stringify(r.body)}`).toBe(400);
  });

  it("(10) PATCH /:caseId/mark-as-remake: sequential suffix — second call on a different case of the same original gets C", async () => {
    const { access } = await makeSession(labOwnerId);
    const { db, cases: casesTable } = dbMod as any;

    const originalId = rid("origSeq");
    const originalNumber = rid("SEQ");
    await db.insert(casesTable).values({
      id: originalId,
      caseNumber: originalNumber,
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      status: "received",
      patientFirstName: "Jane",
      patientLastName: "Sequential",
      doctorName: "Dr. Sequential",
      createdByUserId: labOwnerId,
    });
    createdCaseIds.push(originalId);

    // Pre-existing remake occupying suffix "B".
    const existingRemakeId = rid("existingRemake");
    await db.insert(casesTable).values({
      id: existingRemakeId,
      caseNumber: `${originalNumber}B`,
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      status: "received",
      patientFirstName: "Jane",
      patientLastName: "Sequential",
      doctorName: "Dr. Sequential",
      createdByUserId: labOwnerId,
      remakeOfCaseId: originalId,
      remakeReason: "First remake",
    });
    createdCaseIds.push(existingRemakeId);

    const reviewedCaseId = rid("reviewedSeq");
    await db.insert(casesTable).values({
      id: reviewedCaseId,
      caseNumber: rid("INV3"),
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      status: "received",
      patientFirstName: "Jane",
      patientLastName: "Sequential",
      doctorName: "Dr. Sequential",
      createdByUserId: labOwnerId,
    });
    createdCaseIds.push(reviewedCaseId);

    const r = await request(appMod.default)
      .patch(`/api/cases/${reviewedCaseId}/mark-as-remake`)
      .set("Authorization", `Bearer ${access}`)
      .send({
        remakeOfCaseId: originalId,
        remakeReason: "Second remake via mark-as-remake",
        remakeCharged: true,
      });

    expect(r.status, `expected 200 but got ${r.status}: ${JSON.stringify(r.body)}`).toBe(200);
    expect(
      r.body.data.caseNumber,
      "second remake of the same original must get suffix C, not collide with the existing B",
    ).toBe(`${originalNumber}C`);
  });

  it("(11) PATCH /:caseId/mark-as-remake: non-member of the case's lab/practice gets 403", async () => {
    const { db, cases: casesTable, users, userSessions } = dbMod as any;

    const outsiderId = rid("uoutsider");
    await db.insert(users).values({
      id: outsiderId,
      username: `outsider_${outsiderId}`,
      password: "doesnotmatter",
    });
    const { access: outsiderAccess } = await makeSession(outsiderId);

    const originalId = rid("origOut");
    await db.insert(casesTable).values({
      id: originalId,
      caseNumber: rid("OUT"),
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      status: "received",
      patientFirstName: "Ken",
      patientLastName: "Outsider",
      doctorName: "Dr. Outsider",
      createdByUserId: labOwnerId,
    });
    createdCaseIds.push(originalId);

    const reviewedCaseId = rid("reviewedOut");
    await db.insert(casesTable).values({
      id: reviewedCaseId,
      caseNumber: rid("INV4"),
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      status: "received",
      patientFirstName: "Ken",
      patientLastName: "Outsider",
      doctorName: "Dr. Outsider",
      createdByUserId: labOwnerId,
    });
    createdCaseIds.push(reviewedCaseId);

    const r = await request(appMod.default)
      .patch(`/api/cases/${reviewedCaseId}/mark-as-remake`)
      .set("Authorization", `Bearer ${outsiderAccess}`)
      .send({
        remakeOfCaseId: originalId,
        remakeReason: "Should be forbidden",
        remakeCharged: true,
      });

    expect(r.status, `expected 403 but got ${r.status}: ${JSON.stringify(r.body)}`).toBe(403);

    await db.delete(userSessions).where(eq(userSessions.userId, outsiderId));
    await db.delete(users).where(eq(users.id, outsiderId));
  });
});
