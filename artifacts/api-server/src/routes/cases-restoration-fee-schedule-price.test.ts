/**
 * Regression suite: generalized inline "set fee-schedule price" feature.
 *
 * Generalizes the alloy "set price" affordance to ANY restoration line that
 * shows $0/unpriced because its material/type has no configured price in the
 * pricing tier/override the case resolves to.
 *
 * Protected behaviors:
 *   (1) POST /api/cases/:caseId/restorations/:restorationId/fee-schedule-price
 *       writes the price into the tier/override the case resolves to (the same
 *       resolveAlloyPriceTarget cascade), re-prices the restoration line + the
 *       invoice, and records a case_restoration_price_updated event + audit log.
 *   (2) The write target follows the override → tier → default cascade.
 *   (3) Admin-only: a non-admin member (staff) is rejected with 403.
 *   (4) 404 when the restoration isn't on the case; 400 when the material/type
 *       maps to no fee-schedule key.
 *
 * Skipped when DATABASE_URL is not configured. All inserted rows are cleaned
 * up in afterAll so this suite is safe against a shared dev DB.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { inArray, eq, and } from "drizzle-orm";
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
  caseMediaDir: path.join(os.tmpdir(), "labtrax-test-media-fee-schedule"),
  extractMediaFileName: () => null,
  extractMediaFilenamesFromText: () => [],
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("Restoration fee-schedule price (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let authLib: typeof import("../lib/auth.js");

  const labOwnerId = rid("u");
  const labStaffId = rid("ustaff"); // member without admin role
  const labOrgId = rid("lab");
  const providerOrgId = rid("prov"); // no connection tier → default fallback
  const providerTierOrgId = rid("provt"); // connection points at a named tier

  // Tier "Standard" prices only alloy → zirconia is UNPRICED everywhere unless
  // the case resolves to a named tier or per-doctor override.
  const NAMED_TIER_ZIRC = 175;
  const OVERRIDE_ZIRC = 220;
  const NAMED_TIER = "ZircGold";
  const OVERRIDE_DOCTOR = "Dr. ZircOverride";

  const createdCaseIds: string[] = [];

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

  async function createCase(
    access: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const r = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber: rid("CN"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Zirc",
        patientLastName: rid("Pat"),
        doctorName: "Dr. Default",
        status: "received",
        ...overrides,
      });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const caseId = r.body.data.id;
    createdCaseIds.push(caseId);
    return caseId;
  }

  /** Add a restoration to a case and return its id. */
  async function addRestoration(
    access: string,
    caseId: string,
    body: Record<string, unknown>,
  ): Promise<string> {
    const r = await request(appMod.default)
      .post(`/api/cases/${caseId}/restorations`)
      .set("Authorization", `Bearer ${access}`)
      .send(body);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const { db, caseRestorations } = dbMod as any;
    const rows = await db
      .select()
      .from(caseRestorations)
      .where(eq(caseRestorations.caseId, caseId));
    const match = rows.find(
      (x: any) =>
        (x.toothNumber ?? null) === (body.toothNumber ?? null) &&
        (x.restorationType ?? null) === (body.restorationType ?? null) &&
        (x.priceKey ?? null) !== "alloy",
    );
    expect(match, "added restoration row").toBeDefined();
    return match.id;
  }

  /** Poll for the auto-generated invoice of a case. */
  async function waitForInvoice(caseId: string): Promise<any> {
    const { db, invoices } = dbMod as any;
    let invoice: any;
    for (let i = 0; i < 20; i++) {
      await new Promise((res) => setTimeout(res, 100));
      [invoice] = await db.select().from(invoices).where(eq(invoices.caseId, caseId));
      if (invoice) break;
    }
    expect(invoice, "auto-invoice must exist").toBeDefined();
    return invoice;
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-fee-schedule";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    authLib = await import("../lib/auth.js");

    const {
      db,
      users,
      organizations,
      organizationMemberships,
      organizationConnections,
      pricingTiers,
      pricingOverrides,
    } = dbMod as any;

    await db.insert(users).values([
      { id: labOwnerId, username: `zircowner_${labOwnerId}`, password: "doesnotmatter" },
      { id: labStaffId, username: `zircstaff_${labStaffId}`, password: "doesnotmatter" },
    ]);

    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: rid("ZircTestLab") },
      {
        id: providerOrgId,
        type: "provider",
        name: rid("ZircTestProv"),
        parentLabOrganizationId: labOrgId,
      },
      {
        id: providerTierOrgId,
        type: "provider",
        name: rid("ZircTierProv"),
        parentLabOrganizationId: labOrgId,
      },
    ]);

    await db.insert(organizationMemberships).values([
      {
        id: rid("m"),
        labId: labOrgId,
        userId: labOwnerId,
        role: "owner",
        status: "active",
        approvedByUserId: labOwnerId,
        joinedAt: new Date(),
      },
      {
        id: rid("m"),
        labId: labOrgId,
        userId: labStaffId,
        role: "staff",
        status: "active",
        approvedByUserId: labOwnerId,
        joinedAt: new Date(),
      },
    ]);

    // Standard tier (default fallback) prices ONLY alloy → zirconia unpriced.
    // Named tier prices zirconia → reached via connection.
    await db.insert(pricingTiers).values([
      {
        labOrganizationId: labOrgId,
        name: "Standard",
        pricesJson: { alloy: 40 },
        createdByUserId: labOwnerId,
      },
      {
        labOrganizationId: labOrgId,
        name: NAMED_TIER,
        pricesJson: { zirconia_crown: NAMED_TIER_ZIRC },
        createdByUserId: labOwnerId,
      },
    ]);

    await db.insert(organizationConnections).values({
      labOrganizationId: labOrgId,
      providerOrganizationId: providerTierOrgId,
      status: "active",
      tierName: NAMED_TIER,
      requestedByOrgId: labOrgId,
      requestedByUserId: labOwnerId,
      approvedByUserId: labOwnerId,
      approvedAt: new Date(),
    });

    // Per-doctor override beats both tier and default.
    await db.insert(pricingOverrides).values({
      labOrganizationId: labOrgId,
      doctorName: OVERRIDE_DOCTOR,
      pricesJson: { zirconia_crown: OVERRIDE_ZIRC },
      createdByUserId: labOwnerId,
    });
  });

  beforeEach(async () => {
    await makeSession(labOwnerId);
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const {
      db,
      auditLogs,
      caseEvents,
      caseNotes,
      caseRestorations,
      invoiceLineItems,
      invoices,
      cases: casesTable,
      organizationConnections,
      pricingTiers,
      pricingOverrides,
      userSessions,
      organizationMemberships,
      organizations,
      users,
    } = dbMod as any;

    const labCaseRows: Array<{ id: string }> = await db
      .select({ id: casesTable.id })
      .from(casesTable)
      .where(eq(casesTable.labOrganizationId, labOrgId));
    const allCaseIds = Array.from(
      new Set([...createdCaseIds, ...labCaseRows.map((c) => c.id)]),
    );

    if (allCaseIds.length) {
      await db.delete(caseEvents).where(inArray(caseEvents.caseId, allCaseIds));
      await db.delete(caseNotes).where(inArray(caseNotes.caseId, allCaseIds));
      await db
        .delete(caseRestorations)
        .where(inArray(caseRestorations.caseId, allCaseIds));
      const invRows = await db
        .select({ id: invoices.id })
        .from(invoices)
        .where(inArray(invoices.caseId, allCaseIds));
      const invIds = invRows.map((r: any) => r.id);
      if (invIds.length) {
        await db
          .delete(invoiceLineItems)
          .where(inArray(invoiceLineItems.invoiceId, invIds));
      }
      await db.delete(invoices).where(inArray(invoices.caseId, allCaseIds));
      await db.delete(casesTable).where(inArray(casesTable.id, allCaseIds));
    }

    await db.delete(auditLogs).where(inArray(auditLogs.organizationId, [labOrgId]));
    await db.delete(invoices).where(eq(invoices.labOrganizationId, labOrgId));
    await db.delete(casesTable).where(eq(casesTable.labOrganizationId, labOrgId));
    await db
      .delete(organizationConnections)
      .where(eq(organizationConnections.labOrganizationId, labOrgId));
    await db.delete(pricingOverrides).where(eq(pricingOverrides.labOrganizationId, labOrgId));
    await db.delete(pricingTiers).where(eq(pricingTiers.labOrganizationId, labOrgId));
    await db
      .delete(userSessions)
      .where(inArray(userSessions.userId, [labOwnerId, labStaffId]));
    await db
      .delete(organizationMemberships)
      .where(inArray(organizationMemberships.userId, [labOwnerId, labStaffId]));
    await db
      .delete(organizations)
      .where(inArray(organizations.id, [providerOrgId, providerTierOrgId, labOrgId]));
    await db.delete(users).where(inArray(users.id, [labOwnerId, labStaffId]));
  });

  // ── (1) writes into the default tier, re-prices line + invoice + event ─────

  it("(1) POST fee-schedule-price prices an unpriced line via the default tier, syncs the invoice, and writes an event", async () => {
    const { access } = await makeSession(labOwnerId);
    const { db, caseRestorations, caseEvents, invoiceLineItems, pricingTiers } =
      dbMod as any;

    const caseId = await createCase(access); // Dr. Default + providerOrgId → Standard default
    const invoice = await waitForInvoice(caseId);
    const restorationId = await addRestoration(access, caseId, {
      toothNumber: "8",
      restorationType: "Crown",
      material: "Zirconia",
    });

    // Sanity: the line is unpriced before we set it.
    const [before] = await db
      .select()
      .from(caseRestorations)
      .where(eq(caseRestorations.id, restorationId));
    expect(Number(before.unitPrice ?? 0)).toBe(0);

    const r = await request(appMod.default)
      .post(`/api/cases/${caseId}/restorations/${restorationId}/fee-schedule-price`)
      .set("Authorization", `Bearer ${access}`)
      .send({ price: 150 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.ok).toBe(true);
    expect(r.body.data.priceKey).toBe("zirconia_crown");
    expect(r.body.data.target.kind).toBe("tier");
    expect(Number(r.body.data.amount)).toBe(150);

    // Line re-priced from the default "Standard" tier.
    const [after] = await db
      .select()
      .from(caseRestorations)
      .where(eq(caseRestorations.id, restorationId));
    expect(Number(after.unitPrice)).toBe(150);
    expect(after.priceKey).toBe("zirconia_crown");
    expect(after.priceSource).toBe("default");

    // The price was persisted into the Standard tier's pricesJson.
    const [standardTier] = await db
      .select()
      .from(pricingTiers)
      .where(
        and(
          eq(pricingTiers.labOrganizationId, labOrgId),
          eq(pricingTiers.name, "Standard"),
        ),
      );
    expect(Number(standardTier.pricesJson.zirconia_crown)).toBe(150);

    // A case_restoration_price_updated event with feeSchedulePriceSet marker.
    const events = await db
      .select()
      .from(caseEvents)
      .where(
        and(
          eq(caseEvents.caseId, caseId),
          eq(caseEvents.eventType, "case_restoration_price_updated"),
        ),
      );
    const feeEvents = events.filter(
      (e: any) => e.metadataJson?.feeSchedulePriceSet === true,
    );
    expect(feeEvents).toHaveLength(1);
    expect(feeEvents[0].metadataJson.priceKey).toBe("zirconia_crown");

    // Invoice re-synced with a priced zirconia line.
    const lines = await db
      .select()
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, invoice.id));
    const pricedLine = lines.find((l: any) => Number(l.unitPrice) === 150);
    expect(pricedLine, "invoice has the newly priced line").toBeDefined();
  }, 20000);

  // ── (2) write target follows the override → tier → default cascade ─────────

  it("(2) writes into a named tier when the practice is assigned one", async () => {
    const { access } = await makeSession(labOwnerId);
    const { db, caseRestorations, pricingTiers } = dbMod as any;

    const caseId = await createCase(access, {
      providerOrganizationId: providerTierOrgId,
      doctorName: "Dr. TierGuy",
    });
    const restorationId = await addRestoration(access, caseId, {
      toothNumber: "9",
      restorationType: "Crown",
      material: "Zirconia",
    });

    const r = await request(appMod.default)
      .post(`/api/cases/${caseId}/restorations/${restorationId}/fee-schedule-price`)
      .set("Authorization", `Bearer ${access}`)
      .send({ price: 199 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.target.kind).toBe("tier");
    expect(r.body.data.target.name).toBe(NAMED_TIER);

    const [after] = await db
      .select()
      .from(caseRestorations)
      .where(eq(caseRestorations.id, restorationId));
    expect(Number(after.unitPrice)).toBe(199);
    expect(after.priceSource).toBe("tier");

    const [namedTier] = await db
      .select()
      .from(pricingTiers)
      .where(
        and(
          eq(pricingTiers.labOrganizationId, labOrgId),
          eq(pricingTiers.name, NAMED_TIER),
        ),
      );
    expect(Number(namedTier.pricesJson.zirconia_crown)).toBe(199);
  }, 20000);

  // ── (3) admin-only ─────────────────────────────────────────────────────────

  it("(3) a non-admin member (staff) is rejected with 403", async () => {
    const { access: ownerAccess } = await makeSession(labOwnerId);
    const { access: staffAccess } = await makeSession(labStaffId);

    const caseId = await createCase(ownerAccess);
    const restorationId = await addRestoration(ownerAccess, caseId, {
      toothNumber: "11",
      restorationType: "Crown",
      material: "Zirconia",
    });

    const r = await request(appMod.default)
      .post(`/api/cases/${caseId}/restorations/${restorationId}/fee-schedule-price`)
      .set("Authorization", `Bearer ${staffAccess}`)
      .send({ price: 150 });
    expect(r.status).toBe(403);
  }, 20000);

  // ── (4) error cases ──────────────────────────────────────────────────────

  it("(4) 404 when the restoration isn't on the case", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseId = await createCase(access);

    const r = await request(appMod.default)
      .post(`/api/cases/${caseId}/restorations/${rid("missing")}/fee-schedule-price`)
      .set("Authorization", `Bearer ${access}`)
      .send({ price: 150 });
    expect(r.status).toBe(404);
  }, 20000);

  it("(4) 400 when the material/type maps to no fee-schedule key", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseId = await createCase(access);
    const restorationId = await addRestoration(access, caseId, {
      toothNumber: "12",
      restorationType: "Widget",
      material: "Mystery Material XYZ",
    });

    const r = await request(appMod.default)
      .post(`/api/cases/${caseId}/restorations/${restorationId}/fee-schedule-price`)
      .set("Authorization", `Bearer ${access}`)
      .send({ price: 150 });
    expect(r.status).toBe(400);
  }, 20000);
});
