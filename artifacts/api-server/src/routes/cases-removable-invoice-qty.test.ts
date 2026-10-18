/**
 * Regression guard: multi-tooth Removable cases from the AI import paths must
 * produce exactly ONE invoice line item with QTY = 1.
 *
 * Protected behavior (Task #3425):
 *   Removable appliances (dentures, partials, flippers, overdentures) list
 *   multiple teeth descriptively — "which teeth are missing / have clasps" —
 *   not as a count of billable units. The guard in the AI import route
 *   collapses all teeth into a SINGLE restoration row before case creation.
 *   If someone removes that guard, each tooth would become its own restoration
 *   row, creating one invoice line per tooth instead of QTY = 1.
 *
 * Coverage:
 *   (A) iTero Rx import path (/import-from-itero-rx) with caseTypeHint=Removable
 *       and multiple tooth indices: exactly 1 restoration row + 1 invoice line
 *       with QTY = 1.
 *   (B) Standard POST /api/cases with a single Removable restoration whose
 *       toothNumber is a comma-joined multi-tooth string (the exact shape the
 *       guard produces): exactly 1 invoice line with QTY = 1.
 *   (C) Negative control: iTero Rx import with Crown & Bridge + multiple teeth
 *       produces one restoration per tooth (guard is Removable-specific).
 *
 * Skipped when DATABASE_URL is not configured. All inserted rows are cleaned
 * up in afterAll so this suite is safe against a shared dev DB.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { randomBytes } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
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
  caseMediaDir: path.join(os.tmpdir(), "labtrax-test-media-removable-qty"),
  extractMediaFileName: () => null,
  extractMediaFilenamesFromText: () => [],
}));
vi.mock("../lib/case-media-object-storage.js", () => ({
  openCaseMediaObjectStream: vi.fn().mockResolvedValue(null),
  writeCaseMediaToObjectStorage: vi.fn().mockResolvedValue(undefined),
}));

vi.setConfig({ testTimeout: 90000, hookTimeout: 90000 });

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("Multi-tooth Removable AI import: invoice QTY = 1 (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let authLib: typeof import("../lib/auth.js");

  const labOwnerId = rid("u");
  const labOrgId = rid("lab");
  const providerOrgId = rid("prov");

  const createdCaseIds: string[] = [];

  async function makeSession(userId: string): Promise<{ access: string }> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const refresh = authLib.signRefreshToken(userId, sessionId);
    const hash = createHash("sha256").update(refresh).digest("hex");
    await db
      .insert(userSessions)
      .values({ id: sessionId, userId, tokenHash: hash, expiresAt });
    const access = authLib.signAccessToken(userId, sessionId);
    return { access };
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-removable-qty";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    authLib = await import("../lib/auth.js");

    const { db, users, organizations, organizationMemberships } = dbMod as any;

    await db.insert(users).values({
      id: labOwnerId,
      username: `rmqtyowner_${labOwnerId.slice(-8)}`,
      password: "doesnotmatter",
    });

    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: rid("RemovQtyLab") },
      {
        id: providerOrgId,
        type: "provider",
        name: rid("RemovQtyPractice"),
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
      caseAttachments,
      caseEvents,
      caseNotes,
      caseRestorations,
      invoiceLineItems,
      invoices,
      iteroImportedOrders,
      iteroImportSessions,
      cases: casesTable,
      userSessions,
      organizationMemberships,
      organizations,
      users,
    } = dbMod as any;

    if (createdCaseIds.length) {
      if (caseAttachments)
        await db
          .delete(caseAttachments)
          .where(inArray(caseAttachments.caseId, createdCaseIds));
      if (caseEvents)
        await db
          .delete(caseEvents)
          .where(inArray(caseEvents.caseId, createdCaseIds));
      if (caseNotes)
        await db
          .delete(caseNotes)
          .where(inArray(caseNotes.caseId, createdCaseIds));
      if (caseRestorations)
        await db
          .delete(caseRestorations)
          .where(inArray(caseRestorations.caseId, createdCaseIds));
      const invRows = await db
        .select({ id: invoices.id })
        .from(invoices)
        .where(inArray(invoices.caseId, createdCaseIds));
      const invIds = invRows.map((r: any) => r.id);
      if (invoiceLineItems && invIds.length) {
        await db
          .delete(invoiceLineItems)
          .where(inArray(invoiceLineItems.invoiceId, invIds));
      }
      await db
        .delete(invoices)
        .where(inArray(invoices.caseId, createdCaseIds));
      await db
        .delete(casesTable)
        .where(inArray(casesTable.id, createdCaseIds));
    }

    if (iteroImportedOrders)
      await db
        .delete(iteroImportedOrders)
        .where(eq(iteroImportedOrders.labOrganizationId, labOrgId));
    if (iteroImportSessions)
      await db
        .delete(iteroImportSessions)
        .where(eq(iteroImportSessions.labOrganizationId, labOrgId));

    await db
      .delete(auditLogs)
      .where(inArray(auditLogs.organizationId, [labOrgId, providerOrgId]));
    await db
      .delete(invoices)
      .where(inArray(invoices.labOrganizationId, [labOrgId]));
    await db
      .delete(casesTable)
      .where(inArray(casesTable.labOrganizationId, [labOrgId]));
    await db
      .delete(userSessions)
      .where(inArray(userSessions.userId, [labOwnerId]));
    await db
      .delete(organizationMemberships)
      .where(inArray(organizationMemberships.userId, [labOwnerId]));
    await db.delete(organizations).where(eq(organizations.id, providerOrgId));
    await db.delete(organizations).where(eq(organizations.id, labOrgId));
    await db.delete(users).where(inArray(users.id, [labOwnerId]));
  });

  // ── (A) iTero Rx import: multi-tooth Removable → 1 restoration + 1 invoice line QTY=1 ──
  //
  // Strategy: suppress the AI key so the route uses the hint fields as the
  // sole data source (same approach used by the existing iTero subtype tests).
  // Pass caseTypeHint=Removable and toothIndicesHint="3, 14, 19" (3 teeth).
  // The guard at the Removable branch must collapse all three teeth into ONE
  // restoration row → ONE invoice line with QTY = 1.
  //
  // If the guard is removed the loop creates one row per tooth → 3 restoration
  // rows → 3 invoice lines → the QTY assertion below would fail at 3, not 1.

  it("(A) iTero Rx import: Removable with 3 teeth → 1 restoration row + 1 invoice line QTY=1", async () => {
    const origAiKey = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];
    delete process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];

    try {
      const { access } = await makeSession(labOwnerId);
      const iteroOrderId = rid("iord");

      // Minimal buffer — only read when the OpenAI client is present (suppressed).
      const fakeRxBuffer = Buffer.from("fake-rx-for-removable-qty-test");

      const resp = await request(appMod.default)
        .post("/api/cases/import-from-itero-rx")
        .set("Authorization", `Bearer ${access}`)
        .attach("file", fakeRxBuffer, {
          filename: "test-rx.pdf",
          contentType: "application/pdf",
        })
        .field("iteroOrderId", iteroOrderId)
        .field("labOrganizationId", labOrgId)
        .field("providerOrganizationId", providerOrgId)
        .field("doctorNameHint", "Dr. RemovableQty")
        .field("patientFirstNameHint", "RemovFirst")
        .field("patientLastNameHint", "RemovLast")
        // Three teeth: the guard must collapse them into a single unit.
        .field("toothIndicesHint", "3, 14, 19")
        .field("caseTypeHint", "Removable")
        .field("archHint", "Upper")
        .field("materialHint", "Acrylic")
        // Bypass the strict doctor-gate so we don't need to pre-create the doctor.
        .field("confirmNewDoctor", "true");

      expect(
        resp.status,
        `iTero Rx import must return 200 or 201 (got ${resp.status}): ${JSON.stringify(resp.body)}`,
      ).toSatisfy((s: number) => s === 200 || s === 201);

      const caseId = resp.body.data?.caseId;
      expect(caseId, "response must include caseId").toBeTruthy();
      createdCaseIds.push(caseId);

      const { db, caseRestorations: caseRestorationsTable, invoices, invoiceLineItems } = dbMod as any;

      // ── Assert: exactly 1 restoration row (guard collapsed 3 teeth → 1) ──
      const restRows = await db
        .select()
        .from(caseRestorationsTable)
        .where(eq(caseRestorationsTable.caseId, caseId));

      expect(
        restRows.length,
        "Removable guard must produce exactly 1 restoration row (not one per tooth)",
      ).toBe(1);
      expect(
        restRows[0].restorationType,
        "restoration type must be Removable",
      ).toBe("Removable");

      // ── Assert: exactly 1 invoice line item with QTY = 1 ──
      const invRows = await db
        .select({ id: invoices.id })
        .from(invoices)
        .where(eq(invoices.caseId, caseId));

      expect(invRows.length, "exactly one invoice must exist").toBe(1);

      const lineItems = await db
        .select()
        .from(invoiceLineItems)
        .where(eq(invoiceLineItems.invoiceId, invRows[0].id));

      expect(
        lineItems.length,
        "multi-tooth Removable must produce exactly 1 invoice line (not one per tooth)",
      ).toBe(1);
      expect(
        lineItems[0].quantity,
        "invoice line quantity must be 1 for a Removable appliance",
      ).toBe(1);
    } finally {
      if (origAiKey !== undefined) {
        process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] = origAiKey;
      }
    }
  });

  // ── (B) Standard POST /api/cases: single Removable restoration (multi-tooth toothNumber) ──
  //       → exactly 1 invoice line with QTY = 1
  //
  // The AI import guard produces a single restoration row with a comma-joined
  // toothNumber like "3, 14, 19". This test verifies that when such a row
  // reaches the invoice builder (buildGroupedLineItemsForInvoice /
  // buildGroupedSyncItems), it is treated as one item with QTY = 1 — not split
  // back out by tooth count.

  it("(B) POST /api/cases: single Removable restoration with multi-tooth toothNumber → 1 invoice line QTY=1", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseNumber = rid("RMQTY");

    const createResp = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Denture",
        patientLastName: "Patient",
        doctorName: "Dr. Denture",
        status: "received",
        restorations: [
          {
            // Comma-joined teeth: the exact shape produced by the Removable guard.
            toothNumber: "3, 14, 19",
            restorationType: "Removable",
            material: "Acrylic",
            quantity: 1,
            unitPrice: 0,
            arch: "upper",
          },
        ],
      });

    expect(createResp.status, JSON.stringify(createResp.body)).toBe(201);
    const caseId = createResp.body.data.id;
    createdCaseIds.push(caseId);

    const { db, invoices, invoiceLineItems } = dbMod as any;

    // Wait briefly for async invoice creation (same pattern as existing tests).
    let invRows: any[] = [];
    for (let i = 0; i < 25; i++) {
      await new Promise((res) => setTimeout(res, 100));
      invRows = await db
        .select({ id: invoices.id })
        .from(invoices)
        .where(eq(invoices.caseId, caseId));
      if (invRows.length > 0) break;
    }

    expect(invRows.length, "exactly one invoice must exist").toBe(1);

    const lineItems = await db
      .select()
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, invRows[0].id));

    expect(
      lineItems.length,
      "a single Removable restoration must produce exactly 1 invoice line",
    ).toBe(1);
    expect(
      lineItems[0].quantity,
      "invoice line quantity must be 1 (the restoration row has quantity:1)",
    ).toBe(1);
  });

  // ── (C) Negative control: Crown & Bridge with 3 teeth → 3 restoration rows ──
  //       (the Removable guard must NOT fire for Crown & Bridge)

  it("(C) iTero Rx import: Crown & Bridge with 3 teeth → 3 restoration rows (guard is Removable-specific)", async () => {
    const origAiKey = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];
    delete process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];

    try {
      const { access } = await makeSession(labOwnerId);
      const iteroOrderId = rid("iord-cb");

      const fakeRxBuffer = Buffer.from("fake-rx-for-cnb-qty-test");

      const resp = await request(appMod.default)
        .post("/api/cases/import-from-itero-rx")
        .set("Authorization", `Bearer ${access}`)
        .attach("file", fakeRxBuffer, {
          filename: "test-rx.pdf",
          contentType: "application/pdf",
        })
        .field("iteroOrderId", iteroOrderId)
        .field("labOrganizationId", labOrgId)
        .field("providerOrganizationId", providerOrgId)
        .field("doctorNameHint", "Dr. CnBQty")
        .field("patientFirstNameHint", "CnBFirst")
        .field("patientLastNameHint", "CnBLast")
        // Three teeth for a Crown & Bridge case — each becomes its own unit.
        .field("toothIndicesHint", "12, 13, 14")
        .field("caseTypeHint", "Crown & Bridge")
        .field("materialHint", "Zirconia")
        .field("confirmNewDoctor", "true");

      expect(
        resp.status,
        `iTero Rx import must return 200 or 201 (got ${resp.status}): ${JSON.stringify(resp.body)}`,
      ).toSatisfy((s: number) => s === 200 || s === 201);

      const caseId = resp.body.data?.caseId;
      expect(caseId, "response must include caseId").toBeTruthy();
      createdCaseIds.push(caseId);

      const { db, caseRestorations: caseRestorationsTable } = dbMod as any;

      const restRows = await db
        .select()
        .from(caseRestorationsTable)
        .where(eq(caseRestorationsTable.caseId, caseId));

      expect(
        restRows.length,
        "Crown & Bridge with 3 teeth must produce 3 restoration rows (one per tooth)",
      ).toBe(3);
    } finally {
      if (origAiKey !== undefined) {
        process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] = origAiKey;
      }
    }
  });
});
