import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { inArray, eq } from "drizzle-orm";
import request from "supertest";
import * as path from "node:path";
import * as os from "node:os";

// Mirrors the harness in cases-invoice-creation.test.ts: stub the background
// jobs / media subsystem so importing the app doesn't spin up timers or touch
// the real uploads dir.
vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(os.tmpdir(), "labtrax-test-media-preview-match"),
  extractMediaFileName: () => null,
  extractMediaFilenamesFromText: () => [],
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;
function rid(p: string) {
  return `${p}_${randomBytes(8).toString("hex")}`;
}

type NormalizedLine = {
  description: string;
  quantity: number;
  unitPrice: string;
  lineTotal: string;
};

/**
 * Asserts that the line items + totals returned by POST /invoices/preview-draft
 * exactly match the invoice the case ends up with once it goes through the
 * shared bridge-aware grouping module.
 *
 * Why the case is PATCHed with bridge connectors before reading the invoice:
 * the preview endpoint builds its line items with `buildBridgeAwareLineItems`
 * (shared `invoice-line-grouping.ts`), which collapses bridge/pontic spans and
 * groups same-material restorations. On the case side, that same shared module
 * is driven by `syncInvoiceFromRestorations`. POST /cases does NOT accept
 * `bridgeConnectors` and its inline auto-invoice builder emits one ungrouped
 * line per restoration, so the connectors are applied via the case PATCH route
 * (the real path a user takes when drawing connectors on the tooth chart),
 * which reprices pontics and re-runs the shared grouping. This test pins the
 * preview and the grouped invoice to each other so a regression in either
 * pricing/grouping path can't silently drift them apart.
 */
maybe("preview-draft matches the grouped case invoice", () => {
  let dbMod: any;
  let appMod: any;
  let authLib: any;
  const labOwnerId = rid("u");
  const labOrgId = rid("lab");
  const providerOrgId = rid("prov");
  const createdCaseIds: string[] = [];

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

  beforeAll(async () => {
    process.env["JWT_SECRET"] = process.env["JWT_SECRET"] ?? "preview-match-secret";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    authLib = await import("../lib/auth.js");
    const { db, users, organizations, organizationMemberships, pricingTiers } = dbMod;
    await db.insert(users).values({
      id: labOwnerId,
      username: `pm_${labOwnerId}`,
      password: "x",
    });
    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: rid("PMLab") },
      {
        id: providerOrgId,
        type: "provider",
        name: rid("PMPractice"),
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
    // Default pricing tier: PFM crown $100, zirconia crown $150.
    await db
      .insert(pricingTiers)
      .values({
        labOrganizationId: labOrgId,
        name: "Default",
        pricesJson: { pfm_crown: 100, zirconia_crown: 150 },
      })
      .returning();
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const {
      db,
      caseEvents,
      caseNotes,
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
      const inv = await db
        .select({ id: invoices.id })
        .from(invoices)
        .where(inArray(invoices.caseId, createdCaseIds));
      const ids = inv.map((r: any) => r.id);
      if (ids.length)
        await db.delete(invoiceLineItems).where(inArray(invoiceLineItems.invoiceId, ids));
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

  it("line descriptions, per-line totals, and grand total are identical", async () => {
    const { access } = await makeSession(labOwnerId);

    // Two same-material PFM crowns (a same-material group) plus a 3-unit
    // zirconia bridge spanning teeth 13–15 (crown / pontic / crown).
    const restorations = [
      { toothNumber: "3", restorationType: "Crown", material: "PFM", quantity: 1 },
      { toothNumber: "4", restorationType: "Crown", material: "PFM", quantity: 1 },
      { toothNumber: "13", restorationType: "Crown", material: "Zirconia", quantity: 1 },
      { toothNumber: "14", restorationType: "Pontic", material: "Zirconia", quantity: 1 },
      { toothNumber: "15", restorationType: "Crown", material: "Zirconia", quantity: 1 },
    ];
    const bridgeConnectors = "13-14,14-15";

    // 1) Preview the draft invoice (shared bridge-aware grouping).
    const prev = await request(appMod.default)
      .post("/api/invoices/preview-draft")
      .set("Authorization", `Bearer ${access}`)
      .send({
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        doctorName: "Dr. Preview",
        bridgeConnectors,
        restorations,
      });
    expect(prev.status).toBe(200);
    const previewLines: NormalizedLine[] = (prev.body.data.lineItems as any[]).map((l) => ({
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      lineTotal: l.lineTotal,
    }));
    const previewTotal: string = prev.body.data.total;
    expect(previewLines.length).toBe(2);

    // 2) Create the case with the same restorations.
    const caseNumber = rid("CN");
    const cr = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Preview",
        patientLastName: "Match",
        doctorName: "Dr. Preview",
        status: "received",
        restorations,
      });
    expect(cr.status).toBe(201);
    const caseId = cr.body.data.id;
    createdCaseIds.push(caseId);

    // 3) Apply the bridge connectors via the real case PATCH route, which
    //    reprices pontics and re-runs the shared grouping module
    //    (syncInvoiceFromRestorations) — the same path the preview mirrors.
    const patch = await request(appMod.default)
      .patch(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ bridgeConnectors });
    expect(patch.status).toBe(200);

    // 4) Read the resulting invoice + line items.
    const { db, invoices, invoiceLineItems } = dbMod;
    let invoice: any;
    for (let i = 0; i < 30; i++) {
      [invoice] = await db.select().from(invoices).where(eq(invoices.caseId, caseId));
      if (invoice) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(invoice).toBeTruthy();
    const rawLines = await db
      .select()
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, invoice.id))
      .orderBy(invoiceLineItems.sortOrder);
    const invoiceLines: NormalizedLine[] = rawLines.map((l: any) => ({
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      lineTotal: l.lineTotal,
    }));

    // 5) Preview and the grouped invoice must match line-for-line and in total.
    const sortByDesc = (a: NormalizedLine, b: NormalizedLine) =>
      a.description.localeCompare(b.description);
    expect([...invoiceLines].sort(sortByDesc)).toEqual(
      [...previewLines].sort(sortByDesc),
    );
    expect(invoice.total).toBe(previewTotal);
  });
});
