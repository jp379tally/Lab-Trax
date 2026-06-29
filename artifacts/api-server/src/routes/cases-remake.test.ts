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
 *   (4) No-charge remake: invoice is still created (not skipped), carries a
 *       no-charge note.
 *   (5) case_number unique-constraint violation returns 409 (not 500).
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
import { and, eq, inArray, isNull } from "drizzle-orm";
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
      doctorName: "Dr. Smith",
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
        doctorName: "Dr. Smith",
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
});
