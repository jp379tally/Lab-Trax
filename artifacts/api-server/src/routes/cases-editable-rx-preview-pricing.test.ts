/**
 * Regression suite: editable Rx-preview pricing end-to-end contract.
 *
 * The grouping helper (`invoice-line-grouping.ts`) has unit coverage, but the
 * cross-route contract that powers the desktop "edit a price in the draft
 * invoice preview" flow is exercised here against the real DB:
 *
 *   (1) POST /api/invoices/preview-draft returns a `restorationIndices` array on
 *       every produced line, mapping each line back to the exact request
 *       restorations it was built from — both a same-material grouped line
 *       (multiple indices) and an ungrouped single line (one index). Without
 *       this mapping the desktop can't thread an inline price edit on a grouped
 *       line back to the source restorations.
 *   (2) POST /api/cases with `priceOverridden: true` + `unitPrice: 0` stores the
 *       restoration at $0 with priceSource "manual" — a deliberate no-charge
 *       line is preserved rather than auto-priced back up.
 *   (3) POST /api/cases with an overridden positive price honors that price
 *       (priceSource "manual") instead of resolving the tier price.
 *
 * Skipped when DATABASE_URL is not configured. All inserted rows are cleaned up
 * in afterAll so this suite is safe against a shared dev DB.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { inArray, eq } from "drizzle-orm";
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
  caseMediaDir: path.join(os.tmpdir(), "labtrax-test-media-editable-rx-preview"),
  extractMediaFileName: () => null,
  extractMediaFilenamesFromText: () => [],
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;
function rid(p: string) {
  return `${p}_${randomBytes(8).toString("hex")}`;
}

maybe("Editable Rx preview pricing (db integration)", () => {
  let dbMod: any;
  let appMod: any;
  let authLib: any;
  const labOwnerId = rid("u");
  const labOrgId = rid("lab");
  const providerOrgId = rid("prov");
  const createdCaseIds: string[] = [];

  // Default tier prices: PFM crown $100, zirconia crown $150.
  const PFM_PRICE = 100;
  const ZIRC_PRICE = 150;

  async function makeSession(userId: string) {
    const { db, userSessions } = dbMod;
    const sessionId = rid("sess");
    const refresh = authLib.signRefreshToken(userId, sessionId);
    const hash = createHash("sha256").update(refresh).digest("hex");
    await db.insert(userSessions).values({
      id: sessionId,
      userId,
      tokenHash: hash,
      expiresAt: new Date(Date.now() + 7 * 864e5),
    });
    return { access: authLib.signAccessToken(userId, sessionId) };
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
        patientFirstName: "Rx",
        patientLastName: rid("Pat"),
        doctorName: "Dr. Preview",
        status: "received",
        ...overrides,
      });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const caseId = r.body.data.id;
    createdCaseIds.push(caseId);
    return caseId;
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "editable-rx-preview-secret";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    authLib = await import("../lib/auth.js");
    const { db, users, organizations, organizationMemberships, pricingTiers } = dbMod;
    await db.insert(users).values({
      id: labOwnerId,
      username: `rxp_${labOwnerId}`,
      password: "x",
    });
    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: rid("RxPLab") },
      {
        id: providerOrgId,
        type: "provider",
        name: rid("RxPPractice"),
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
    await db.insert(pricingTiers).values({
      labOrganizationId: labOrgId,
      name: "Default",
      pricesJson: { pfm_crown: PFM_PRICE, zirconia_crown: ZIRC_PRICE },
      createdByUserId: labOwnerId,
    });
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const {
      db,
      caseEvents,
      caseNotes,
      caseRestorations,
      invoiceLineItems,
      invoices,
      cases,
      userSessions,
      organizationMemberships,
      organizations,
      users,
      pricingTiers,
    } = dbMod;
    if (createdCaseIds.length) {
      await db.delete(caseEvents).where(inArray(caseEvents.caseId, createdCaseIds));
      await db.delete(caseNotes).where(inArray(caseNotes.caseId, createdCaseIds));
      await db
        .delete(caseRestorations)
        .where(inArray(caseRestorations.caseId, createdCaseIds));
      const inv = await db
        .select({ id: invoices.id })
        .from(invoices)
        .where(inArray(invoices.caseId, createdCaseIds));
      const ids = inv.map((r: any) => r.id);
      if (ids.length)
        await db
          .delete(invoiceLineItems)
          .where(inArray(invoiceLineItems.invoiceId, ids));
      await db.delete(invoices).where(inArray(invoices.caseId, createdCaseIds));
      await db.delete(cases).where(inArray(cases.id, createdCaseIds));
    }
    await db.delete(pricingTiers).where(eq(pricingTiers.labOrganizationId, labOrgId));
    await db.delete(userSessions).where(inArray(userSessions.userId, [labOwnerId]));
    await db
      .delete(organizationMemberships)
      .where(inArray(organizationMemberships.userId, [labOwnerId]));
    await db
      .delete(organizations)
      .where(inArray(organizations.id, [providerOrgId, labOrgId]));
    await db.delete(users).where(inArray(users.id, [labOwnerId]));
  });

  // ── (1) restorationIndices map produced lines back to request restorations ──

  it("(1) preview-draft returns restorationIndices for grouped and single lines", async () => {
    const { access } = await makeSession(labOwnerId);

    // Index 0 + 1: two same-material PFM crowns → collapse into ONE grouped
    // line whose restorationIndices is [0, 1].
    // Index 2: a single zirconia crown → its own line, restorationIndices [2].
    const restorations = [
      { toothNumber: "3", restorationType: "Crown", material: "PFM", quantity: 1 },
      { toothNumber: "4", restorationType: "Crown", material: "PFM", quantity: 1 },
      { toothNumber: "13", restorationType: "Crown", material: "Zirconia", quantity: 1 },
    ];

    const prev = await request(appMod.default)
      .post("/api/invoices/preview-draft")
      .set("Authorization", `Bearer ${access}`)
      .send({
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        doctorName: "Dr. Preview",
        restorations,
      });
    expect(prev.status, JSON.stringify(prev.body)).toBe(200);

    const lines = prev.body.data.lineItems as any[];

    // Every produced line carries a restorationIndices array.
    for (const l of lines) {
      expect(Array.isArray(l.restorationIndices)).toBe(true);
    }

    // Each index appears exactly once across all lines, and the union covers
    // every request restoration (0, 1, 2).
    const allIndices = lines
      .flatMap((l) => l.restorationIndices as number[])
      .sort((a, b) => a - b);
    expect(allIndices).toEqual([0, 1, 2]);

    // The grouped PFM line maps to indices [0, 1]; the single zirconia line
    // maps to [2].
    const groupedLine = lines.find((l) => l.restorationIndices.length === 2);
    const singleLine = lines.find((l) => l.restorationIndices.length === 1);
    expect(groupedLine, "a grouped (multi-index) line exists").toBeDefined();
    expect(singleLine, "a single-index line exists").toBeDefined();
    expect([...groupedLine.restorationIndices].sort((a: number, b: number) => a - b)).toEqual([0, 1]);
    expect(singleLine.restorationIndices).toEqual([2]);

    // Sanity: the grouped line is the PFM group, the single line is zirconia,
    // and both resolved their tier price.
    expect(Number(groupedLine.unitPrice)).toBe(PFM_PRICE);
    expect(Number(singleLine.unitPrice)).toBe(ZIRC_PRICE);
  }, 20000);

  // ── (2) explicit $0 override is preserved, not auto-priced ──────────────────

  it("(2) priceOverridden + unitPrice 0 stores a $0 manual line (not auto-priced)", async () => {
    const { access } = await makeSession(labOwnerId);
    const { db, caseRestorations } = dbMod;

    // A PFM crown would auto-price to $100, but the user marked it no-charge.
    const caseId = await createCase(access, {
      restorations: [
        {
          toothNumber: "8",
          restorationType: "Crown",
          material: "PFM",
          quantity: 1,
          unitPrice: 0,
          priceOverridden: true,
        },
      ],
    });

    const rows = await db
      .select()
      .from(caseRestorations)
      .where(eq(caseRestorations.caseId, caseId));
    expect(rows).toHaveLength(1);
    const [r] = rows;
    expect(Number(r.unitPrice)).toBe(0);
    expect(r.priceSource).toBe("manual");
  }, 20000);

  // ── (3) an overridden positive price is honored over the tier price ─────────

  it("(3) priceOverridden positive price is honored over the tier price", async () => {
    const { access } = await makeSession(labOwnerId);
    const { db, caseRestorations } = dbMod;

    // PFM crown tier price is $100; the user set $250 explicitly.
    const OVERRIDE = 250;
    const caseId = await createCase(access, {
      restorations: [
        {
          toothNumber: "9",
          restorationType: "Crown",
          material: "PFM",
          quantity: 1,
          unitPrice: OVERRIDE,
          priceOverridden: true,
        },
      ],
    });

    const rows = await db
      .select()
      .from(caseRestorations)
      .where(eq(caseRestorations.caseId, caseId));
    expect(rows).toHaveLength(1);
    const [r] = rows;
    expect(Number(r.unitPrice)).toBe(OVERRIDE);
    expect(r.priceSource).toBe("manual");
  }, 20000);
});
