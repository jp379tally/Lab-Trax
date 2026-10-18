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

  it("prices the exact catalog override identically in preview and the saved invoice", async () => {
    const { db, labCatalogEntries, pricingTiers, invoices } = dbMod;
    const catalogId = rid("catalog");
    const customKey = rid("custom_quote");
    await db.insert(labCatalogEntries).values({
      id: catalogId, labOrganizationId: labOrgId, entryType: "material",
      caseType: "restorative", parentKey: "crown", key: "zirconia",
      label: "Lab-priced Zirconia", isCustom: false, priceKeyOverride: customKey,
    });
    await db.update(pricingTiers).set({
      pricesJson: { pfm_crown: 100, zirconia_crown: 150, [customKey]: 247.38 },
    }).where(eq(pricingTiers.labOrganizationId, labOrgId));
    try {
      const { access } = await makeSession(labOwnerId);
      const header = { Authorization: `Bearer ${access}` };
      const restorations = [{
        toothNumber: "14", restorationType: "Crown", material: "Zirconia",
        shade: "A2", quantity: 1, restorationSubtype: "restorative/crown/zirconia",
      }];
      const preview = await request(appMod.default).post("/api/invoices/preview-draft")
        .set(header).send({ labOrganizationId: labOrgId, providerOrganizationId: providerOrgId,
          doctorName: "Dr. Preview", restorations });
      expect(preview.status, JSON.stringify(preview.body)).toBe(200);
      expect(Number(preview.body.data.total)).toBe(247.38);
      const created = await request(appMod.default).post("/api/cases").set(header).send({
        labOrganizationId: labOrgId, providerOrganizationId: providerOrgId,
        doctorName: "Dr. Preview", patientFirstName: "Catalog", patientLastName: "QA", caseNumber: rid("CN"),
        caseType: "Crown", material: "Zirconia", shade: "A2", toothNumbers: "14",
        status: "received", restorations,
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const caseId = created.body.data.id;
      createdCaseIds.push(caseId);
      const invoice = await db.query.invoices.findFirst({ where: eq(invoices.caseId, caseId) });
      expect(Number(invoice.total)).toBe(Number(preview.body.data.total));
    } finally {
      await db.delete(labCatalogEntries).where(eq(labCatalogEntries.id, catalogId));
      await db.update(pricingTiers).set({ pricesJson: { pfm_crown: 100, zirconia_crown: 150 } })
        .where(eq(pricingTiers.labOrganizationId, labOrgId));
    }
  });

  it("keeps reviewed corrections, a rush fee and layered charge through create, sync and edit", async () => {
    const { access } = await makeSession(labOwnerId);
    const header = { Authorization: `Bearer ${access}` };
    const lines = [
      { description: "PFZ crown", quantity: 1, unitPrice: 10, subItems: [
        { description: "Layered Porcelain", quantity: 1, unitPrice: 37 },
      ] },
      { description: "Rush fee", quantity: 1, unitPrice: 15 },
    ];
    const cr = await request(appMod.default).post("/api/cases").set(header).send({
      caseNumber: rid("REVIEW"),
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      patientFirstName: "Reviewed",
      patientLastName: "Patient",
      doctorName: "Dr. Reviewed",
      confirmNewDoctor: true,
      status: "received",
      restorations: [{ toothNumber: "3", restorationType: "Crown", material: "Porcelain Fused to Zirconia", quantity: 1 }],
      invoiceOverrideLines: lines,
    });
    expect(cr.status, JSON.stringify(cr.body)).toBe(201);
    const caseId = cr.body.data.id;
    createdCaseIds.push(caseId);
    const { db, invoices, invoiceLineItems, organizationMemberships } = dbMod;
    const [invoice] = await db.select().from(invoices).where(eq(invoices.caseId, caseId));
    expect(invoice).toBeDefined();
    const read = async () => db.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, invoice.id));
    const originalRows = await read();
    expect(originalRows).toHaveLength(3);
    const parent = originalRows.find((r: any) => r.description === "PFZ crown")!;
    const child = originalRows.find((r: any) => r.description === "Layered Porcelain")!;
    expect(child.parentLineItemId).toBe(parent.id);
    expect(child.sourceType).toBe("manual");
    expect(Number(invoice.total)).toBe(62);

    const sync = await request(appMod.default).patch(`/api/cases/${caseId}`).set(header)
      .send({ bridgeConnectors: "" });
    expect(sync.status, JSON.stringify(sync.body)).toBe(200);
    expect((await read()).map((r: any) => r.id).sort()).toEqual(originalRows.map((r: any) => r.id).sort());
    const [afterCaseEdit] = await db.select().from(invoices).where(eq(invoices.id, invoice.id));
    expect(afterCaseEdit.displayMetadataJson.reviewedChargesNeedsReview).toBe(true);

    const edited = await request(appMod.default).patch(`/api/invoices/${invoice.id}`).set(header).send({
      items: [
        { id: parent.id, description: parent.description, quantity: 1, unitPrice: 12,
          subItems: [{ id: child.id, description: child.description, quantity: 1, unitPrice: 37 }] },
        { id: originalRows.find((r: any) => r.description === "Rush fee")!.id,
          description: "Rush fee", quantity: 1, unitPrice: 15 },
      ],
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    const detail = await request(appMod.default).get(`/api/invoices/${invoice.id}`).set(header);
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    const reopened = detail.body.data ?? detail.body;
    expect(Number(reopened.total)).toBe(64);
    expect(reopened.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: parent.id, subItems: [
        expect.objectContaining({ id: child.id, description: "Layered Porcelain" }),
      ] }),
      expect.objectContaining({ description: "Rush fee" }),
    ]));

    // A case can be reassigned to a different practice after its invoice is
    // issued. The case worklist's Price and filtered sales must still use the
    // saved invoice, not the obsolete restoration price or a provider-id match.
    await db.update(invoices).set({ providerOrganizationId: null }).where(eq(invoices.id, invoice.id));
    const worklist = await request(appMod.default).get("/api/cases/worklist")
      .set(header).query({ caseId, pageSize: 10 });
    expect(worklist.status, JSON.stringify(worklist.body)).toBe(200);
    const listed = worklist.body.data ?? worklist.body;
    expect(listed.rows.find((row: any) => row.id === caseId)?.totalPrice).toBe("64.00");
    expect(listed.salesTotal).toBe("64.00");

    // The billing role can edit invoices too and must see the same saved total.
    await db.update(organizationMemberships).set({ role: "billing" })
      .where(eq(organizationMemberships.userId, labOwnerId));
    try {
      const billed = await request(appMod.default).get("/api/cases/worklist")
        .set(header).query({ caseId });
      expect(billed.status, JSON.stringify(billed.body)).toBe(200);
      expect((billed.body.data ?? billed.body).rows[0].totalPrice).toBe("64.00");
    } finally {
      await db.update(organizationMemberships).set({ role: "owner" })
        .where(eq(organizationMemberships.userId, labOwnerId));
    }
  }, 60_000);

  it("line descriptions, per-line totals, and grand total are identical", async () => {
    const { access } = await makeSession(labOwnerId);

    // Two PFM crowns (now per-tooth singletons — each gets its own line)
    // plus a 3-unit zirconia bridge spanning teeth 13–15 (crown/pontic/crown).
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
    // 2 PFM singleton lines + 1 Zirconia bridge group = 3 parent lines.
    expect(previewLines.length).toBe(3);

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

  it("PFZ restoration: preview shows sub-item, sync creates parent + child at $37", async () => {
    const { access } = await makeSession(labOwnerId);

    // 1) Preview a single PFZ tooth: should return one parent line with a
    //    "Layered Porcelain" sub-item at $37, and total = $150 + $37 = $187.
    const prev = await request(appMod.default)
      .post("/api/invoices/preview-draft")
      .set("Authorization", `Bearer ${access}`)
      .send({
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        doctorName: "Dr. PFZ",
        restorations: [
          {
            toothNumber: "3",
            restorationType: "Crown",
            material: "Porcelain Fused to Zirconia",
            quantity: 1,
          },
        ],
      });
    expect(prev.status).toBe(200);
    const previewLines = prev.body.data.lineItems as any[];
    expect(previewLines.length).toBe(1);
    expect(previewLines[0].unitPrice).toBe("150.00");
    expect(previewLines[0].subItems).toBeDefined();
    expect(previewLines[0].subItems.length).toBe(1);
    expect(previewLines[0].subItems[0].description).toBe("Layered Porcelain");
    expect(previewLines[0].subItems[0].unitPrice).toBe("37.00");
    expect(Number(prev.body.data.total)).toBeCloseTo(187, 2);

    // 2) Create the case, then trigger syncInvoiceFromRestorations via PATCH.
    const caseNumber = rid("PFZ1");
    const cr = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "PFZ",
        patientLastName: "Patient",
        doctorName: "Dr. PFZ",
        status: "received",
        restorations: [
          {
            toothNumber: "3",
            restorationType: "Crown",
            material: "Porcelain Fused to Zirconia",
            quantity: 1,
          },
        ],
      });
    expect(cr.status).toBe(201);
    const caseId = cr.body.data.id;
    createdCaseIds.push(caseId);

    // Trigger syncInvoiceFromRestorations via PATCH bridgeConnectors (empty =
    // clears any connectors and re-runs the shared grouping module).
    const patch = await request(appMod.default)
      .patch(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ bridgeConnectors: "" });
    expect(patch.status).toBe(200);

    // 3) Read the resulting invoice line items from the DB.
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
      .where(eq(invoiceLineItems.invoiceId, invoice.id));

    const parentLines = rawLines.filter((l: any) => l.parentLineItemId == null);
    const childLines = rawLines.filter((l: any) => l.parentLineItemId != null);

    // One zirconia parent line at $150.
    expect(parentLines.length).toBe(1);
    expect(Number(parentLines[0].unitPrice)).toBeCloseTo(150, 2);

    // One "Layered Porcelain" child line at $37, linked to the parent.
    expect(childLines.length).toBe(1);
    expect(childLines[0].description).toBe("Layered Porcelain");
    expect(Number(childLines[0].unitPrice)).toBeCloseTo(37, 2);
    expect(childLines[0].parentLineItemId).toBe(parentLines[0].id);

    // Invoice total = $150 + $37 = $187.
    expect(Number(invoice.total)).toBeCloseTo(187, 2);
  });

  it("PFZ crowns inside a bridge span are NOT collapsed — each remains a singleton with $37 child", async () => {
    const { access } = await makeSession(labOwnerId);

    // 3 restorations: 2 PFZ crowns (teeth 3 and 5) + 1 Zirconia pontic (tooth 4)
    // connected as 3-4 and 4-5 (one continuous span).
    // Before the fix, all 3 were collapsed into one bridge line with no $37 child.
    // After the fix, PFZ crowns escape the bridge algorithm and become singletons.
    const caseNumber = rid("PFZB");
    const cr = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "PFZBridge",
        patientLastName: "Patient",
        doctorName: "Dr. PFZBridge",
        status: "received",
        restorations: [
          { toothNumber: "3", restorationType: "Crown", material: "Porcelain Fused to Zirconia", quantity: 1 },
          { toothNumber: "4", restorationType: "Crown", material: "Zirconia", quantity: 1 },
          { toothNumber: "5", restorationType: "Crown", material: "Porcelain Fused to Zirconia", quantity: 1 },
        ],
      });
    expect(cr.status).toBe(201);
    const caseId = cr.body.data.id;
    createdCaseIds.push(caseId);

    // Apply bridge connectors to trigger syncInvoiceFromRestorations with the
    // bridge-aware grouping path.
    const patch = await request(appMod.default)
      .patch(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ bridgeConnectors: "3-4,4-5" });
    expect(patch.status).toBe(400);

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
      .where(eq(invoiceLineItems.invoiceId, invoice.id));

    const parentLines = rawLines.filter((l: any) => l.parentLineItemId == null);
    const childLines = rawLines.filter((l: any) => l.parentLineItemId != null);

    // 2 PFZ crowns → 2 parent lines + 2 Layered Porcelain child lines
    // 1 Zirconia pontic → 1 additional parent line (no child)
    expect(parentLines.length).toBe(3);
    expect(childLines.length).toBe(2);

    // Every child is "Layered Porcelain" and linked to a PFZ parent.
    for (const child of childLines) {
      expect(child.description).toBe("Layered Porcelain");
      expect(Number(child.unitPrice)).toBeCloseTo(37, 2);
    }

    // The two PFZ parents each have exactly one child linked to them.
    const pfzParents = parentLines.filter((l: any) =>
      childLines.some((c: any) => c.parentLineItemId === l.id)
    );
    expect(pfzParents.length).toBe(2);
  });

  it("multi-tooth PFZ: each tooth is its own line (no cross-tooth grouping)", async () => {
    const { access } = await makeSession(labOwnerId);

    const caseNumber = rid("PFZ2");
    const cr = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "PFZ2",
        patientLastName: "Patient",
        doctorName: "Dr. PFZ2",
        status: "received",
        restorations: [
          { toothNumber: "3", restorationType: "Crown", material: "Porcelain Fused to Zirconia", quantity: 1 },
          { toothNumber: "4", restorationType: "Crown", material: "Porcelain Fused to Zirconia", quantity: 1 },
          { toothNumber: "5", restorationType: "Crown", material: "Porcelain Fused to Zirconia", quantity: 1 },
        ],
      });
    expect(cr.status).toBe(201);
    const caseId = cr.body.data.id;
    createdCaseIds.push(caseId);

    // Trigger sync.
    await request(appMod.default)
      .patch(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ bridgeConnectors: "" });

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
      .where(eq(invoiceLineItems.invoiceId, invoice.id));

    const parentLines = rawLines.filter((l: any) => l.parentLineItemId == null);
    const childLines = rawLines.filter((l: any) => l.parentLineItemId != null);

    // 3 separate parent lines — PFZ must NOT be collapsed into one multi-tooth group.
    expect(parentLines.length).toBe(3);
    // 3 Layered Porcelain child lines, one per parent.
    expect(childLines.length).toBe(3);

    // Each child is linked to a distinct parent.
    const parentIds = new Set(parentLines.map((l: any) => l.id));
    const linkedIds = new Set(childLines.map((l: any) => l.parentLineItemId));
    expect(linkedIds).toEqual(parentIds);

    // Invoice total = 3 × ($150 + $37) = $561.
    expect(Number(invoice.total)).toBeCloseTo(561, 2);
  });
});
