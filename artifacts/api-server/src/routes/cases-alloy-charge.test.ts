/**
 * Regression suite: Alloy surcharge feature (Task #2067, tested in #2076).
 *
 * Protected behaviors:
 *   (1) POST /api/cases/:caseId/alloy-charge adds a priced "Alloy"
 *       restoration row + a restoration_added event, re-syncs the invoice,
 *       and is idempotent (a second call returns added:false and creates no
 *       duplicate row / line).
 *   (2) Adding a PFM restoration auto-adds an alloy line ONLY when the lab's
 *       organizations.autoAddAlloyOnPfm flag is true, and never duplicates
 *       it across multiple PFM restorations.
 *   (3) The alloy unit price resolves through the override → tier → default
 *       cascade, and the alloy line renders as a plain "Alloy" description on
 *       the invoice (buildBasicDescription), not "Alloy - Tooth N/A".
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
  caseMediaDir: path.join(os.tmpdir(), "labtrax-test-media-alloy"),
  extractMediaFileName: () => null,
  extractMediaFilenamesFromText: () => [],
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("Alloy surcharge feature (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let authLib: typeof import("../lib/auth.js");

  const labOwnerId = rid("u");
  const labOrgId = rid("lab");
  const providerOrgId = rid("prov"); // no connection tier → default fallback
  const providerTierOrgId = rid("provt"); // connection points at a named tier

  // Standard tier (default fallback) and a named tier reached via connection.
  const STANDARD_ALLOY = 40;
  const NAMED_TIER_ALLOY = 60;
  const OVERRIDE_ALLOY = 95;
  const NAMED_TIER = "AlloyGold";
  const OVERRIDE_DOCTOR = "Dr. AlloyOverride";

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
        patientFirstName: "Alloy",
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

  async function setAutoAddAlloy(value: boolean): Promise<void> {
    const { db, organizations } = dbMod as any;
    await db
      .update(organizations)
      .set({ autoAddAlloyOnPfm: value })
      .where(eq(organizations.id, labOrgId));
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] = process.env["JWT_SECRET"] ?? "labtrax-test-secret-alloy";
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

    await db.insert(users).values({
      id: labOwnerId,
      username: `alloyowner_${labOwnerId}`,
      password: "doesnotmatter",
    });

    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: rid("AlloyTestLab") },
      {
        id: providerOrgId,
        type: "provider",
        name: rid("AlloyTestProv"),
        parentLabOrganizationId: labOrgId,
      },
      {
        id: providerTierOrgId,
        type: "provider",
        name: rid("AlloyTierProv"),
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

    // Standard tier → default fallback; named tier → reached via connection.
    await db.insert(pricingTiers).values([
      {
        labOrganizationId: labOrgId,
        name: "Standard",
        pricesJson: { alloy: STANDARD_ALLOY },
        createdByUserId: labOwnerId,
      },
      {
        labOrganizationId: labOrgId,
        name: NAMED_TIER,
        pricesJson: { alloy: NAMED_TIER_ALLOY },
        createdByUserId: labOwnerId,
      },
    ]);

    // Connection that assigns providerTierOrgId to the named tier.
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
      pricesJson: { alloy: OVERRIDE_ALLOY },
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

    // Cover every case ever created on the lab (defensive: covers any case the
    // tests created via the API that may not be in createdCaseIds).
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
    await db.delete(userSessions).where(inArray(userSessions.userId, [labOwnerId]));
    await db
      .delete(organizationMemberships)
      .where(inArray(organizationMemberships.userId, [labOwnerId]));
    await db
      .delete(organizations)
      .where(inArray(organizations.id, [providerOrgId, providerTierOrgId, labOrgId]));
    await db.delete(users).where(inArray(users.id, [labOwnerId]));
  });

  // ── (1) alloy-charge endpoint: adds a priced line + event, idempotent ─────

  it("(1) POST /:caseId/alloy-charge adds a priced Alloy restoration + event, re-syncs invoice, and is idempotent", async () => {
    const { access } = await makeSession(labOwnerId);
    const { db, caseRestorations, caseEvents, invoiceLineItems } = dbMod as any;

    const caseId = await createCase(access); // Dr. Default + providerOrgId → Standard default
    const invoice = await waitForInvoice(caseId);

    // First call → added.
    const r1 = await request(appMod.default)
      .post(`/api/cases/${caseId}/alloy-charge`)
      .set("Authorization", `Bearer ${access}`)
      .send({});
    expect(r1.status).toBe(201);
    expect(r1.body.data.added).toBe(true);
    expect(r1.body.data.alreadyPresent).toBe(false);
    expect(r1.body.data.priced).toBe(true);
    expect(r1.body.data.restorationId).toBeTruthy();

    // Exactly one alloy restoration row, priced from the Standard tier.
    const alloyRows = await db
      .select()
      .from(caseRestorations)
      .where(
        and(
          eq(caseRestorations.caseId, caseId),
          eq(caseRestorations.priceKey, "alloy"),
        ),
      );
    expect(alloyRows).toHaveLength(1);
    expect(alloyRows[0].restorationType).toBe("Alloy");
    expect(Number(alloyRows[0].unitPrice)).toBe(STANDARD_ALLOY);

    // A restoration_added event carrying the alloySurcharge marker exists.
    const events = await db
      .select()
      .from(caseEvents)
      .where(
        and(
          eq(caseEvents.caseId, caseId),
          eq(caseEvents.eventType, "restoration_added"),
        ),
      );
    const alloyEvents = events.filter(
      (e: any) => e.metadataJson?.alloySurcharge === true,
    );
    expect(alloyEvents, "exactly one restoration_added event with alloySurcharge marker").toHaveLength(1);

    // Invoice was re-synced with an Alloy line item.
    const linesAfterFirst = await db
      .select()
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, invoice.id));
    const alloyLines = linesAfterFirst.filter((l: any) => l.description === "Alloy");
    expect(alloyLines).toHaveLength(1);

    // Second call → idempotent no-op.
    const r2 = await request(appMod.default)
      .post(`/api/cases/${caseId}/alloy-charge`)
      .set("Authorization", `Bearer ${access}`)
      .send({});
    expect(r2.status).toBe(200);
    expect(r2.body.data.added).toBe(false);
    expect(r2.body.data.alreadyPresent).toBe(true);

    // Still exactly one alloy restoration and one alloy invoice line.
    const alloyRowsAfter = await db
      .select()
      .from(caseRestorations)
      .where(
        and(
          eq(caseRestorations.caseId, caseId),
          eq(caseRestorations.priceKey, "alloy"),
        ),
      );
    expect(alloyRowsAfter).toHaveLength(1);

    const linesAfterSecond = await db
      .select()
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, invoice.id));
    expect(linesAfterSecond.filter((l: any) => l.description === "Alloy")).toHaveLength(1);
  }, 20000);

  // ── (2) PFM auto-add gated on autoAddAlloyOnPfm, never duplicates ─────────

  it("(2) adding a PFM restoration does NOT auto-add alloy when autoAddAlloyOnPfm is false", async () => {
    const { access } = await makeSession(labOwnerId);
    const { db, caseRestorations } = dbMod as any;

    await setAutoAddAlloy(false);
    const caseId = await createCase(access);

    const r = await request(appMod.default)
      .post(`/api/cases/${caseId}/restorations`)
      .set("Authorization", `Bearer ${access}`)
      .send({ toothNumber: "8", restorationType: "PFM Crown", material: "PFM" });
    expect(r.status).toBe(201);

    const alloyRows = await db
      .select()
      .from(caseRestorations)
      .where(
        and(
          eq(caseRestorations.caseId, caseId),
          eq(caseRestorations.priceKey, "alloy"),
        ),
      );
    expect(alloyRows).toHaveLength(0);
  }, 20000);

  it("(2) adding PFM restorations auto-adds alloy once when autoAddAlloyOnPfm is true, never duplicates", async () => {
    const { access } = await makeSession(labOwnerId);
    const { db, caseRestorations } = dbMod as any;

    await setAutoAddAlloy(true);
    try {
      const caseId = await createCase(access);

      // First PFM → auto-adds alloy.
      const r1 = await request(appMod.default)
        .post(`/api/cases/${caseId}/restorations`)
        .set("Authorization", `Bearer ${access}`)
        .send({ toothNumber: "8", restorationType: "PFM Crown", material: "PFM" });
      expect(r1.status).toBe(201);

      let alloyRows = await db
        .select()
        .from(caseRestorations)
        .where(
          and(
            eq(caseRestorations.caseId, caseId),
            eq(caseRestorations.priceKey, "alloy"),
          ),
        );
      expect(alloyRows).toHaveLength(1);

      // Second PFM → must NOT add a second alloy line.
      const r2 = await request(appMod.default)
        .post(`/api/cases/${caseId}/restorations`)
        .set("Authorization", `Bearer ${access}`)
        .send({ toothNumber: "9", restorationType: "PFM Crown", material: "PFM" });
      expect(r2.status).toBe(201);

      alloyRows = await db
        .select()
        .from(caseRestorations)
        .where(
          and(
            eq(caseRestorations.caseId, caseId),
            eq(caseRestorations.priceKey, "alloy"),
          ),
        );
      expect(alloyRows).toHaveLength(1);
    } finally {
      await setAutoAddAlloy(false);
    }
  }, 25000);

  // ── (3) price resolution cascade + plain "Alloy" description ──────────────

  it("(3) alloy price resolves via the default tier and renders as plain 'Alloy' on the invoice", async () => {
    const { access } = await makeSession(labOwnerId);
    const { db, caseRestorations, invoiceLineItems } = dbMod as any;

    // Dr. Default + providerOrgId (no override, no connection tier) → Standard "default".
    const caseId = await createCase(access);
    const invoice = await waitForInvoice(caseId);

    const r = await request(appMod.default)
      .post(`/api/cases/${caseId}/alloy-charge`)
      .set("Authorization", `Bearer ${access}`)
      .send({});
    expect(r.status).toBe(201);

    const [alloyRow] = await db
      .select()
      .from(caseRestorations)
      .where(
        and(
          eq(caseRestorations.caseId, caseId),
          eq(caseRestorations.priceKey, "alloy"),
        ),
      );
    expect(Number(alloyRow.unitPrice)).toBe(STANDARD_ALLOY);
    expect(alloyRow.priceSource).toBe("default");

    const lines = await db
      .select()
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, invoice.id));
    const alloyLine = lines.find((l: any) => l.description === "Alloy");
    expect(alloyLine, "alloy line renders as plain 'Alloy'").toBeDefined();
    // Never the tooth-suffixed form.
    expect(lines.some((l: any) => /Alloy - Tooth/i.test(l.description))).toBe(false);
  }, 20000);

  it("(3) alloy price resolves via a named tier when the practice is assigned one", async () => {
    const { access } = await makeSession(labOwnerId);
    const { db, caseRestorations } = dbMod as any;

    // providerTierOrgId is connected to NAMED_TIER → "tier" source.
    const caseId = await createCase(access, {
      providerOrganizationId: providerTierOrgId,
      doctorName: "Dr. TierGuy",
    });

    const r = await request(appMod.default)
      .post(`/api/cases/${caseId}/alloy-charge`)
      .set("Authorization", `Bearer ${access}`)
      .send({});
    expect(r.status).toBe(201);

    const [alloyRow] = await db
      .select()
      .from(caseRestorations)
      .where(
        and(
          eq(caseRestorations.caseId, caseId),
          eq(caseRestorations.priceKey, "alloy"),
        ),
      );
    expect(Number(alloyRow.unitPrice)).toBe(NAMED_TIER_ALLOY);
    expect(alloyRow.priceSource).toBe("tier");
  }, 20000);

  it("(3) alloy price resolves via a per-doctor override, beating tier and default", async () => {
    const { access } = await makeSession(labOwnerId);
    const { db, caseRestorations } = dbMod as any;

    // Dr. AlloyOverride has an override alloy price → "override" source wins.
    const caseId = await createCase(access, { doctorName: OVERRIDE_DOCTOR });

    const r = await request(appMod.default)
      .post(`/api/cases/${caseId}/alloy-charge`)
      .set("Authorization", `Bearer ${access}`)
      .send({});
    expect(r.status).toBe(201);

    const [alloyRow] = await db
      .select()
      .from(caseRestorations)
      .where(
        and(
          eq(caseRestorations.caseId, caseId),
          eq(caseRestorations.priceKey, "alloy"),
        ),
      );
    expect(Number(alloyRow.unitPrice)).toBe(OVERRIDE_ALLOY);
    expect(alloyRow.priceSource).toBe("override");
  }, 20000);
});
