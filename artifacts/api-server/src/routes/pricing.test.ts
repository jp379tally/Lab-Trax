/**
 * Integration tests for pricing tiers and overrides routes (regression guard).
 *
 * Skipped when DATABASE_URL is not configured. All inserted rows are removed
 * in afterAll so the suite is safe to run against a shared dev DB.
 *
 * Coverage:
 *  - POST /api/pricing/tiers — creates a tier (201)
 *  - POST /api/pricing/tiers — 409 on duplicate name in same lab
 *  - GET /api/pricing/tiers — returns the created tier
 *  - POST /api/pricing/overrides — creates a per-doctor override (201)
 *  - POST /api/pricing/overrides — 409 on duplicate doctorName in same lab
 *  - GET /api/pricing/overrides — returns the created override
 *  - Non-admin requests return 403
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { inArray, eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import request from "supertest";
import * as path from "node:path";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(require("os").tmpdir(), "labtrax-test-media-pricing"),
  extractMediaFileName: () => null,
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("Pricing tiers and overrides (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let authLib: typeof import("../lib/auth.js");

  const adminId = rid("u");
  const nonAdminId = rid("na");
  const labOrgId = rid("lab");
  const providerOrgId = rid("prov");

  async function makeSession(userId: string): Promise<{ access: string; refresh: string }> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const refresh = authLib.signRefreshToken(userId, sessionId);
    const hash = createHash("sha256").update(refresh).digest("hex");
    await db.insert(userSessions).values({ id: sessionId, userId, tokenHash: hash, expiresAt });
    const access = authLib.signAccessToken(userId, sessionId);
    return { access, refresh };
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-pricing";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    authLib = await import("../lib/auth.js");

    const { db, users, organizations, organizationMemberships } = dbMod as any;

    await db.insert(users).values([
      { id: adminId, username: `pricingadmin_${adminId}`, password: "x" },
      { id: nonAdminId, username: `pricingnon_${nonAdminId}`, password: "x" },
    ]);

    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: rid("PricingTestLab") },
      {
        id: providerOrgId,
        type: "provider",
        name: rid("PricingTestProv"),
        parentLabOrganizationId: labOrgId,
      },
    ]);

    await db.insert(organizationMemberships).values([
      {
        id: rid("m1"),
        labId: labOrgId,
        userId: adminId,
        role: "owner",
        status: "active",
        approvedByUserId: adminId,
        joinedAt: new Date(),
      },
      {
        id: rid("m2"),
        labId: labOrgId,
        userId: nonAdminId,
        role: "user",
        status: "active",
        approvedByUserId: adminId,
        joinedAt: new Date(),
      },
    ]);
  });

  // Ensure a fresh session exists before each test; per-test sessions created
  // in each it() body are still the authoritative token for that test.
  beforeEach(async () => {
    await makeSession(adminId);
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const {
      db,
      auditLogs,
      caseEvents,
      caseNotes,
      cases: casesTable,
      invoices,
      pricingOverrides,
      pricingTiers,
      userSessions,
      organizationMemberships,
      organizations,
      users,
    } = dbMod as any;

    await db.delete(auditLogs).where(inArray(auditLogs.organizationId, [labOrgId]));
    // Clean up any cases created (e.g. by the resolve-items test) before
    // deleting organizations FK-referenced by cases.
    const labCaseRows: Array<{ id: string }> = await db
      .select({ id: casesTable.id })
      .from(casesTable)
      .where(eq(casesTable.labOrganizationId, labOrgId));
    const labCaseIds = labCaseRows.map((c) => c.id);
    if (labCaseIds.length) {
      await db.delete(caseEvents).where(inArray(caseEvents.caseId, labCaseIds));
      await db.delete(caseNotes).where(inArray(caseNotes.caseId, labCaseIds));
      await db.delete(invoices).where(inArray(invoices.caseId, labCaseIds));
    }
    await db.delete(invoices).where(eq(invoices.labOrganizationId, labOrgId));
    await db.delete(casesTable).where(eq(casesTable.labOrganizationId, labOrgId));
    await db.delete(pricingOverrides).where(eq(pricingOverrides.labOrganizationId, labOrgId));
    await db.delete(pricingTiers).where(eq(pricingTiers.labOrganizationId, labOrgId));
    await db.delete(userSessions).where(inArray(userSessions.userId, [adminId, nonAdminId]));
    await db.delete(organizationMemberships).where(
      inArray(organizationMemberships.userId, [adminId, nonAdminId])
    );
    await db.delete(organizations).where(eq(organizations.id, providerOrgId));
    await db.delete(organizations).where(eq(organizations.id, labOrgId));
    await db.delete(users).where(inArray(users.id, [adminId, nonAdminId]));
  });

  // ── POST /api/pricing/tiers ───────────────────────────────────────────────

  it("POST /api/pricing/tiers creates a tier and returns 201", async () => {
    const { access } = await makeSession(adminId);
    const name = rid("Tier");

    const r = await request(appMod.default)
      .post("/api/pricing/tiers")
      .set("Authorization", `Bearer ${access}`)
      .send({ labOrganizationId: labOrgId, name });

    expect(r.status).toBe(201);
    expect(r.body.data).toBeDefined();
    expect(r.body.data.name).toBe(name);
    expect(r.body.data.labOrganizationId).toBe(labOrgId);
  });

  it("POST /api/pricing/tiers — duplicate name in same lab returns 409", async () => {
    const { access } = await makeSession(adminId);
    const name = rid("DupTier");

    const first = await request(appMod.default)
      .post("/api/pricing/tiers")
      .set("Authorization", `Bearer ${access}`)
      .send({ labOrganizationId: labOrgId, name });
    expect(first.status).toBe(201);

    const second = await request(appMod.default)
      .post("/api/pricing/tiers")
      .set("Authorization", `Bearer ${access}`)
      .send({ labOrganizationId: labOrgId, name });
    expect(second.status).toBe(409);
  });

  it("POST /api/pricing/tiers — non-admin returns 403", async () => {
    const { access } = await makeSession(nonAdminId);

    const r = await request(appMod.default)
      .post("/api/pricing/tiers")
      .set("Authorization", `Bearer ${access}`)
      .send({ labOrganizationId: labOrgId, name: rid("ForbiddenTier") });

    expect(r.status).toBe(403);
  });

  it("GET /api/pricing/tiers returns the created tier", async () => {
    const { access } = await makeSession(adminId);
    const name = rid("GetTier");

    const create = await request(appMod.default)
      .post("/api/pricing/tiers")
      .set("Authorization", `Bearer ${access}`)
      .send({ labOrganizationId: labOrgId, name });
    expect(create.status).toBe(201);
    const tierId = create.body.data.id;

    const list = await request(appMod.default)
      .get(`/api/pricing/tiers?labOrganizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${access}`);
    expect(list.status).toBe(200);
    const ids: string[] = (list.body.data?.tiers ?? []).map((t: any) => t.id);
    expect(ids).toContain(tierId);
  });

  // ── POST /api/pricing/overrides ───────────────────────────────────────────

  it("POST /api/pricing/overrides creates a per-doctor override and returns 201", async () => {
    const { access } = await makeSession(adminId);
    const doctorName = rid("Dr");

    const r = await request(appMod.default)
      .post("/api/pricing/overrides")
      .set("Authorization", `Bearer ${access}`)
      .send({ labOrganizationId: labOrgId, doctorName });

    expect(r.status).toBe(201);
    expect(r.body.data).toBeDefined();
    expect(r.body.data.doctorName).toBe(doctorName);
    expect(r.body.data.labOrganizationId).toBe(labOrgId);
  });

  it("POST /api/pricing/overrides — duplicate doctorName in same lab returns 409", async () => {
    const { access } = await makeSession(adminId);
    const doctorName = rid("DupDr");

    const first = await request(appMod.default)
      .post("/api/pricing/overrides")
      .set("Authorization", `Bearer ${access}`)
      .send({ labOrganizationId: labOrgId, doctorName });
    expect(first.status).toBe(201);

    const second = await request(appMod.default)
      .post("/api/pricing/overrides")
      .set("Authorization", `Bearer ${access}`)
      .send({ labOrganizationId: labOrgId, doctorName });
    expect(second.status).toBe(409);
  });

  it("POST /api/pricing/overrides — non-admin returns 403", async () => {
    const { access } = await makeSession(nonAdminId);

    const r = await request(appMod.default)
      .post("/api/pricing/overrides")
      .set("Authorization", `Bearer ${access}`)
      .send({ labOrganizationId: labOrgId, doctorName: rid("ForbiddenDr") });

    expect(r.status).toBe(403);
  });

  it("GET /api/pricing/overrides returns the created override", async () => {
    const { access } = await makeSession(adminId);
    const doctorName = rid("GetDr");

    const create = await request(appMod.default)
      .post("/api/pricing/overrides")
      .set("Authorization", `Bearer ${access}`)
      .send({ labOrganizationId: labOrgId, doctorName });
    expect(create.status).toBe(201);
    const ovId = create.body.data.id;

    const list = await request(appMod.default)
      .get(`/api/pricing/overrides?labOrganizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${access}`);
    expect(list.status).toBe(200);
    const ids: string[] = (list.body.data?.overrides ?? []).map((o: any) => o.id);
    expect(ids).toContain(ovId);
  });

  // ── PATCH /api/pricing/overrides/:id — update prices ─────────────────────

  it("PATCH /api/pricing/overrides/:id updates the stored prices for the override", async () => {
    const { access } = await makeSession(adminId);
    const doctorName = rid("PatchDr");

    const create = await request(appMod.default)
      .post("/api/pricing/overrides")
      .set("Authorization", `Bearer ${access}`)
      .send({
        labOrganizationId: labOrgId,
        doctorName,
        prices: { pfm_crown: 100 },
      });
    expect(create.status).toBe(201);
    const ovId: string = create.body.data.id;

    const patch = await request(appMod.default)
      .patch(`/api/pricing/overrides/${ovId}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ prices: { pfm_crown: 50 } });
    expect(patch.status).toBe(200);

    // Retrieve and confirm the updated price is stored
    const list = await request(appMod.default)
      .get(`/api/pricing/overrides?labOrganizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${access}`);
    expect(list.status).toBe(200);
    const override = (list.body.data?.overrides ?? []).find(
      (o: any) => o.id === ovId
    );
    expect(override).toBeDefined();
    expect(Number(override?.prices?.pfm_crown ?? override?.pricesJson?.pfm_crown)).toBe(50);
  });

  // ── Pricing precedence: override > tier ───────────────────────────────────
  //
  // Both a tier and a per-doctor override can store a price for the same key.
  // The server resolution logic applies override > named tier > default tier.
  // This test verifies the two data stores hold independent values, which is
  // the data-layer contract that makes the precedence rule work.

  it("override and tier store independent prices for the same key (override > tier precedence data)", async () => {
    const { access } = await makeSession(adminId);
    const tierName = rid("PrecTier");
    const doctorName = rid("PrecDr");

    // Tier price for pfm_crown: 120
    const tier = await request(appMod.default)
      .post("/api/pricing/tiers")
      .set("Authorization", `Bearer ${access}`)
      .send({
        labOrganizationId: labOrgId,
        name: tierName,
        prices: { pfm_crown: 120 },
      });
    expect(tier.status).toBe(201);

    // Override price for pfm_crown: 80 (override wins at resolution time)
    const override = await request(appMod.default)
      .post("/api/pricing/overrides")
      .set("Authorization", `Bearer ${access}`)
      .send({
        labOrganizationId: labOrgId,
        doctorName,
        prices: { pfm_crown: 80 },
      });
    expect(override.status).toBe(201);

    // Verify tier stores 120 and override stores 80 for the same key.
    // At resolution time the override value (80) takes precedence over the tier (120).
    const tierPrice = Number(
      tier.body.data?.prices?.pfm_crown ??
        tier.body.data?.pricesJson?.pfm_crown
    );
    const overridePrice = Number(
      override.body.data?.prices?.pfm_crown ??
        override.body.data?.pricesJson?.pfm_crown
    );
    expect(tierPrice).toBe(120);
    expect(overridePrice).toBe(80);
    // Override price is lower (different), confirming separate storage per doctor.
    expect(overridePrice).toBeLessThan(tierPrice);
  });

  // ── GET /api/pricing/resolve-items — behavioral resolution order ─────────
  //
  // The server resolves prices as: per-doctor override > tier > default.
  // This test verifies the ACTUAL endpoint behavior: when both an override and
  // a tier exist for the same key, the override value is returned.

  it("GET /api/pricing/resolve-items — override price beats tier price for the same key", async () => {
    const { access } = await makeSession(adminId);
    const doctorName = rid("ResolveDr");
    const PRICE_KEY = "pfm_crown"; // a standard item key

    // Create a case with the test doctorName so resolve-items has a caseId.
    const caseResp = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber: rid("CN"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        doctorName,
        patientFirstName: "Test",
        patientLastName: rid("Pat"),
        status: "received",
      });
    expect(caseResp.status).toBe(201);
    const caseId: string = caseResp.body.data.id;

    // Tier: pfm_crown = 120
    const tier = await request(appMod.default)
      .post("/api/pricing/tiers")
      .set("Authorization", `Bearer ${access}`)
      .send({ labOrganizationId: labOrgId, name: rid("ResolveTier"), prices: { [PRICE_KEY]: 120 } });
    expect(tier.status).toBe(201);

    // Override for this doctorName: pfm_crown = 80 (should win over tier)
    const override = await request(appMod.default)
      .post("/api/pricing/overrides")
      .set("Authorization", `Bearer ${access}`)
      .send({ labOrganizationId: labOrgId, doctorName, prices: { [PRICE_KEY]: 80 } });
    expect(override.status).toBe(201);

    try {
      const r = await request(appMod.default)
        .get(`/api/pricing/resolve-items?caseId=${caseId}`)
        .set("Authorization", `Bearer ${access}`);
      expect(r.status).toBe(200);

      const items: Array<{ key: string; unitPrice: number; source: string }> =
        r.body.data?.items ?? [];
      const pfmItem = items.find((i) => i.key === PRICE_KEY);
      expect(pfmItem).toBeDefined();
      // Override (80) must beat the tier (120)
      expect(pfmItem?.unitPrice).toBe(80);
      expect(pfmItem?.source).toBe("override");
    } finally {
      // Cases are soft-deleted; the afterAll pruner covers the lab's cases.
      // Tiers/overrides are cleaned up by afterAll too.
    }
  }, 20000);

  // ── GET /api/pricing/resolve-items — tier beats default ($0) fallback ───────
  //
  // Completes the precedence chain: override > tier > default.
  // When no per-doctor override exists, the tier price is returned instead of $0.

  it("GET /api/pricing/resolve-items — tier price returned when no override exists (tier beats default)", async () => {
    const { access } = await makeSession(adminId);
    const noDrName = rid("NoDrOverride");
    const TIER_KEY = "pfm_crown";

    // Case for this doctor (no override will be created for them)
    const caseResp = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber: rid("CN"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        doctorName: noDrName,
        patientFirstName: "Jane",
        patientLastName: rid("Doe"),
        status: "received",
      });
    expect(caseResp.status).toBe(201);
    const caseId: string = caseResp.body.data.id;

    // A tier named "Standard" with pfm_crown = 95.
    // resolveAllPricesForContext prefers a tier literally named "Standard" as
    // the default fallback, so this is the reliable way to inject a price
    // without relying on creation-order (oldest-tier heuristic).
    const tier = await request(appMod.default)
      .post("/api/pricing/tiers")
      .set("Authorization", `Bearer ${access}`)
      .send({ labOrganizationId: labOrgId, name: "Standard", prices: { [TIER_KEY]: 95 } });
    expect(tier.status).toBe(201);

    const r = await request(appMod.default)
      .get(`/api/pricing/resolve-items?caseId=${caseId}`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);

    const items: Array<{ key: string; unitPrice: number; source: string | null }> =
      r.body.data?.items ?? [];
    const pfmItem = items.find((i) => i.key === TIER_KEY);
    expect(pfmItem).toBeDefined();
    // Tier (95) beats the $0 default — source must be "tier" or "default"
    expect(pfmItem?.unitPrice).toBe(95);
    expect(["tier", "default"]).toContain(pfmItem?.source);
  });

  // ── Percentage discounts: persistence + validation bounds ─────────────────

  it("POST /pricing/overrides persists default + per-item discount, clamps via Zod (0-100)", async () => {
    const { access } = await makeSession(adminId);
    const doctorName = rid("DiscDr");

    const create = await request(appMod.default)
      .post("/api/pricing/overrides")
      .set("Authorization", `Bearer ${access}`)
      .send({
        labOrganizationId: labOrgId,
        doctorName,
        defaultDiscountPercent: 15,
        discountPercents: { pfm_crown: 25 },
      });
    expect(create.status).toBe(201);
    expect(Number(create.body.data.defaultDiscountPercent)).toBe(15);
    expect(Number(create.body.data.discountPercents.pfm_crown)).toBe(25);
    const ovId: string = create.body.data.id;

    // PATCH updates the default discount and adds a per-item entry.
    const patch = await request(appMod.default)
      .patch(`/api/pricing/overrides/${ovId}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ defaultDiscountPercent: 10, discountPercents: { emax_crown: 30 } });
    expect(patch.status).toBe(200);
    expect(Number(patch.body.data.defaultDiscountPercent)).toBe(10);
    expect(Number(patch.body.data.discountPercents.emax_crown)).toBe(30);

    // Out-of-range values are rejected (Zod max 100).
    const tooHighDefault = await request(appMod.default)
      .patch(`/api/pricing/overrides/${ovId}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ defaultDiscountPercent: 150 });
    expect(tooHighDefault.status).toBe(400);

    const tooHighPerItem = await request(appMod.default)
      .patch(`/api/pricing/overrides/${ovId}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ discountPercents: { pfm_crown: 200 } });
    expect(tooHighPerItem.status).toBe(400);

    // The list endpoint reads the persisted discount fields back.
    const list = await request(appMod.default)
      .get(`/api/pricing/overrides?labOrganizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${access}`);
    expect(list.status).toBe(200);
    const found = (list.body.data?.overrides ?? []).find(
      (o: any) => o.id === ovId,
    );
    expect(Number(found?.defaultDiscountPercent)).toBe(10);
    expect(Number(found?.discountPercents?.emax_crown)).toBe(30);
  });

  // ── Percentage discount resolution: off practice default (connection) tier ─
  //
  // Precedence: exact dollar override > percentage discount off practice
  // default tier > doctor/connection/lab-default/standard tier chain.

  it("GET /pricing/resolve-items — discount applies off practice default tier; exact $ wins; per-item % beats default %; missing base falls through", async () => {
    const { access } = await makeSession(adminId);
    const { db, organizations, organizationConnections } = dbMod as any;

    // Dedicated provider org + connection so this test's practice-default tier
    // doesn't perturb the other resolution tests that share providerOrgId.
    const discProviderId = rid("discprov");
    await db.insert(organizations).values({
      id: discProviderId,
      type: "provider",
      name: rid("DiscProv"),
      parentLabOrganizationId: labOrgId,
    });

    // Practice default tier on the lab↔practice connection.
    const baseTierName = rid("DiscBaseTier");
    await db.insert(organizationConnections).values({
      id: rid("conn"),
      labOrganizationId: labOrgId,
      providerOrganizationId: discProviderId,
      status: "active",
      tierName: baseTierName,
      requestedByOrgId: labOrgId,
      requestedByUserId: adminId,
    });

    // Base tier prices: pfm_crown=100 (has base), emax_crown=200 (has base),
    // gold_crown intentionally NOT priced (no base → discount must fall through).
    const tier = await request(appMod.default)
      .post("/api/pricing/tiers")
      .set("Authorization", `Bearer ${access}`)
      .send({
        labOrganizationId: labOrgId,
        name: baseTierName,
        prices: { pfm_crown: 100, emax_crown: 200, zirconia_crown: 300 },
      });
    expect(tier.status).toBe(201);

    const doctorName = rid("DiscResolveDr");
    // Override: default 10% off, pfm_crown overridden to 25% off, an exact
    // dollar price on emax_crown (which must beat the discount entirely), and
    // zirconia_crown explicitly set to 0% off (an explicit "full base price"
    // override that must still pin to the practice-default tier, not fall
    // through to the chain).
    const override = await request(appMod.default)
      .post("/api/pricing/overrides")
      .set("Authorization", `Bearer ${access}`)
      .send({
        labOrganizationId: labOrgId,
        doctorName,
        providerOrganizationId: discProviderId,
        prices: { emax_crown: 111 },
        defaultDiscountPercent: 10,
        discountPercents: { pfm_crown: 25, zirconia_crown: 0 },
      });
    expect(override.status).toBe(201);

    const caseResp = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber: rid("CN"),
        labOrganizationId: labOrgId,
        providerOrganizationId: discProviderId,
        doctorName,
        patientFirstName: "Disc",
        patientLastName: rid("Pat"),
        status: "received",
      });
    expect(caseResp.status).toBe(201);
    const caseId: string = caseResp.body.data.id;

    const r = await request(appMod.default)
      .get(`/api/pricing/resolve-items?caseId=${caseId}`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    const items: Array<{ key: string; unitPrice: number; source: string | null }> =
      r.body.data?.items ?? [];

    // pfm_crown: per-item 25% off 100 = 75 (per-item % beats default %).
    const pfm = items.find((i) => i.key === "pfm_crown");
    expect(pfm?.unitPrice).toBe(75);
    expect(pfm?.source).toBe("discount");

    // emax_crown: exact dollar override (111) wins over the 10% discount.
    const emax = items.find((i) => i.key === "emax_crown");
    expect(emax?.unitPrice).toBe(111);
    expect(emax?.source).toBe("override");

    // gold_crown: default 10% would apply but base tier has no price → falls
    // through to the normal chain (no discount, source not "discount").
    const gold = items.find((i) => i.key === "gold_crown");
    expect(gold?.source).not.toBe("discount");

    // zirconia_crown: explicit 0% per-item override → full practice-default
    // base price (300) with source "discount" (explicit 0 is a configured
    // discount, not "unset").
    const zir = items.find((i) => i.key === "zirconia_crown");
    expect(zir?.unitPrice).toBe(300);
    expect(zir?.source).toBe("discount");
  }, 20000);

  // ── Tier history after PATCH ───────────────────────────────────────────────

  it("GET /pricing/tiers/:id/history returns audit entries after a PATCH", async () => {
    const { access } = await makeSession(adminId);

    const create = await request(appMod.default)
      .post("/api/pricing/tiers")
      .set("Authorization", `Bearer ${access}`)
      .send({
        labOrganizationId: labOrgId,
        name: rid("HistTier"),
        prices: { pfm_crown: 200 },
      });
    expect(create.status).toBe(201);
    const tierId: string = create.body.data.id;

    const patch = await request(appMod.default)
      .patch(`/api/pricing/tiers/${tierId}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ prices: { pfm_crown: 150 } });
    expect(patch.status).toBe(200);

    const hist = await request(appMod.default)
      .get(`/api/pricing/tiers/${tierId}/history`)
      .set("Authorization", `Bearer ${access}`);
    expect(hist.status).toBe(200);
    const entries: unknown[] = hist.body.data?.entries ?? [];
    expect(entries.length).toBeGreaterThan(0);
  });
});
