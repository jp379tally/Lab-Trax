/**
 * Regression suite: restorationSubtype round-trip through the cases API.
 *
 * A silent type mismatch in the taxonomy key (e.g. wrong slash format or
 * an unrecognized key) would produce empty stats breakdowns with no error.
 * These tests ensure the field is persisted and returned correctly on every
 * write path so a mismatch is caught before it reaches the stats pipeline.
 *
 * Protected behaviors:
 *   (1) POST /api/cases with restorations that include `restorationSubtype`
 *       stores the field and returns it on GET /api/cases/:id.
 *   (2) POST /api/cases/:id/restorations with `restorationSubtype` stores
 *       and returns the field in the 201 response.
 *   (3) PATCH /api/cases/:id/restorations/:id with `restorationSubtype: null`
 *       clears the field (returns null in the 200 response).
 *   (4) GET /api/cases/:id after PATCH reflects the cleared field.
 *
 * Skipped when DATABASE_URL is not configured. All inserted rows are cleaned
 * up in afterAll so the suite is safe against a shared dev DB.
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
  caseMediaDir: path.join(os.tmpdir(), "labtrax-test-media-rst-subtype"),
  extractMediaFileName: () => null,
  extractMediaFilenamesFromText: () => [],
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("restorationSubtype round-trip (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let authLib: typeof import("../lib/auth.js");

  const labOwnerId = rid("u");
  const providerUserId = rid("viewer");
  const labOrgId = rid("lab");
  const providerOrgId = rid("prov");
  const createdCaseIds: string[] = [];

  it("commits mixed clinical notes, hierarchy, explicit chart intent and manual rows atomically with the invoice", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseId = await createCase(access);
    const { randomUUID } = await import("node:crypto");
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const send = (body: Record<string, unknown>) => request(appMod.default)
      .patch(`/api/cases/${caseId}/tooth-chart`).set("Authorization", `Bearer ${access}`).send(body);
    await send({
      creates: ids.map((localId, index) => ({
        localId, toothNumber: String(index + 2), restorationType: index === 1 ? "Pontic" : "Crown",
        material: "Zirconia", restorationSubtype: "restorative/crown_and_bridge/zirconia",
        shade: "A2", quantity: 1, unitPrice: index === 1 ? 80 : 100,
      })), updates: [], deletes: [], bridgeConnectors: "2-3,3-4",
    }).expect(200);
    const hierarchy = { restorationType: "restorative", material: "Zirconia",
      restorationSubtype: "restorative/crown_and_bridge/zirconia", toothNumbers: ["2", "3"], shade: "A3" };
    const committed = await send({
      caseDetails: { rxNotes: "Synthetic atomic clinical note" }, hierarchy,
      creates: [{ localId: randomUUID(), toothNumber: "18", restorationType: "Other", quantity: 2, unitPrice: 20 }],
      updates: [{ restorationId: ids[2], toothNumber: "5", shade: "B1" }],
      deletes: [ids[1]], bridgeConnectors: null,
    });
    expect(committed.status, JSON.stringify(committed.body)).toBe(200);
    const { db, cases, caseRestorations, invoices, invoiceLineItems } = dbMod;
    const rows = await db.select().from(caseRestorations).where(eq(caseRestorations.caseId, caseId));
    expect(rows.map((row) => row.toothNumber).sort()).toEqual(["18", "2", "5"]);
    expect(rows.find((row) => row.id === ids[2])).toMatchObject({ toothNumber: "5", shade: "B1" });
    expect(rows.find((row) => row.id === ids[0])?.shade).toBe("A3");
    const [savedCase] = await db.select().from(cases).where(eq(cases.id, caseId));
    expect(savedCase.rxNotes).toBe("Synthetic atomic clinical note");
    const [invoice] = await db.select().from(invoices).where(eq(invoices.caseId, caseId));
    expect(Number(invoice.total)).toBe(240);
    const lines = await db.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, invoice.id));
    const refused = await send({
      caseDetails: { rxNotes: "Must roll back" },
      hierarchy: { ...hierarchy, toothNumbers: ["2", "5"], shade: "C1" },
      creates: [{ localId: randomUUID(), toothNumber: "10", restorationType: "Crown", material: "" }],
      updates: [], deletes: [ids[0]], bridgeConnectors: null,
    });
    expect(refused.status).toBe(400);
    expect(await db.select().from(cases).where(eq(cases.id, caseId))).toEqual([savedCase]);
    expect(await db.select().from(caseRestorations).where(eq(caseRestorations.caseId, caseId))).toEqual(rows);
    expect(await db.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, invoice.id))).toEqual(lines);
    expect(await db.select().from(invoices).where(eq(invoices.id, invoice.id))).toEqual([invoice]);
  });

  it("saves and reopens explicit crown/pontic bridge roles and an independent veneer without duplicating units", async () => {
    const { access } = await makeSession(labOwnerId);
    const response = await request(appMod.default).post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber: rid("CLINICAL-ROUNDTRIP"), labOrganizationId: labOrgId, providerOrganizationId: providerOrgId,
        patientFirstName: "Synthetic", patientLastName: "ToothRoundTrip", doctorName: "Synthetic Doctor",
        bridgeConnectors: "2-3,3-4",
        restorations: [
          ...["Crown", "Pontic", "Crown"].map((restorationType, index) => ({
            toothNumber: String(index + 2), restorationType, material: "Zirconia",
            restorationSubtype: "restorative/crown_and_bridge/zirconia", shade: "A2", quantity: 1,
          })),
          { toothNumber: "8", restorationType: "Veneer", material: "e.max",
            restorationSubtype: "restorative/crown_and_bridge/emax", shade: "A1", quantity: 1 },
        ],
      });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const caseId = response.body.data.id as string;
    createdCaseIds.push(caseId);
    const reopened = await request(appMod.default).get(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${access}`).expect(200);
    expect(reopened.body.data.bridgeConnectors).toBe("2-3,3-4");
    const rows = reopened.body.data.restorations as Array<{ id: string; toothNumber: string; restorationType: string; material: string; shade: string; quantity: number }>;
    expect(rows).toHaveLength(4);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ toothNumber: "2", restorationType: "Crown", material: "Zirconia", shade: "A2", quantity: 1 }),
      expect.objectContaining({ toothNumber: "3", restorationType: "Pontic", material: "Zirconia", shade: "A2", quantity: 1 }),
      expect.objectContaining({ toothNumber: "4", restorationType: "Crown", material: "Zirconia", shade: "A2", quantity: 1 }),
      expect.objectContaining({ toothNumber: "8", restorationType: "Veneer", material: "e.max", shade: "A1", quantity: 1 }),
    ]));
    const veneer = rows.find((row) => row.toothNumber === "8")!;
    await request(appMod.default).patch(`/api/cases/${caseId}/restorations/${veneer.id}`)
      .set("Authorization", `Bearer ${access}`).send({ shade: "B1" }).expect(200);
    const edited = await request(appMod.default).get(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${access}`).expect(200);
    expect(edited.body.data.restorations).toHaveLength(4);
    expect(edited.body.data.restorations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: veneer.id, toothNumber: "8", restorationType: "Veneer", shade: "B1" }),
    ]));
  });

  async function makeSession(userId: string): Promise<{ access: string }> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const refresh = authLib.signRefreshToken(userId, sessionId);
    const hash = createHash("sha256").update(refresh).digest("hex");
    await db
      .insert(userSessions)
      .values({ id: sessionId, userId, tokenHash: hash, expiresAt });
    return { access: authLib.signAccessToken(userId, sessionId) };
  }

  async function createCase(access: string): Promise<string> {
    const r = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber: rid("CN"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Subtype",
        patientLastName: rid("Pat"),
        doctorName: "Dr. Subtype",
        status: "received",
      });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const caseId = r.body.data.id as string;
    createdCaseIds.push(caseId);
    return caseId;
  }

  it("persists one charge per denture arch, distinct fixed indications, catalog repricing and removal without duplicates", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseId = await createCase(access);
    const { randomUUID } = await import("node:crypto");
    const { db, caseRestorations, invoices, invoiceLineItems, organizations, pricingTiers } = dbMod as any;
    const upper = randomUUID(), lower = randomUUID(), coping = randomUUID(), overlay = randomUUID();
    const send = (body: object) => request(appMod.default).patch(`/api/cases/${caseId}/tooth-chart`)
      .set("Authorization", `Bearer ${access}`).send(body);
    const body = { creates: [
      { localId: upper, restorationType: "Denture", toothNumber: "", arch: "upper", material: "Acrylic", restorationSubtype: "removable/dentures/acrylic", quantity: 1, unitPrice: 500 },
      { localId: lower, restorationType: "Denture", toothNumber: "", arch: "lower", material: "Acrylic", restorationSubtype: "removable/dentures/acrylic", quantity: 1, unitPrice: 600 },
      { localId: coping, restorationType: "Coping", toothNumber: "2", material: "Zirconia", quantity: 1, unitPrice: 75 },
      { localId: overlay, restorationType: "Overlay", toothNumber: "4", material: "Zirconia", quantity: 1, unitPrice: 50 },
    ], updates: [], deletes: [], bridgeConnectors: null };
    const first = await send(body);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    await send(body).expect(200);
    const rows = await db.select().from(caseRestorations).where(eq(caseRestorations.caseId, caseId));
    expect(rows).toHaveLength(4);
    expect(rows.filter((row: any) => row.restorationType === "Denture")).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: upper, arch: "upper", quantity: 1, toothNumber: "" }),
      expect.objectContaining({ id: lower, arch: "lower", quantity: 1, toothNumber: "" }),
    ]));
    const invoice = await db.query.invoices.findFirst({ where: eq(invoices.caseId, caseId) });
    expect(Number(invoice.total)).toBe(1225);
    const lines = await db.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, invoice.id));
    expect(lines.filter((line: any) => line.caseRestorationId === upper || line.caseRestorationId === lower)).toHaveLength(2);
    expect(lines.every((line: any) => Number(line.quantity) === 1)).toBe(true);

    const { resolveRestorationPriceKey } = await import("../lib/restoration-pricing.js");
    const key = await resolveRestorationPriceKey({ labOrganizationId: labOrgId, material: "Flexible", restorationType: "Denture", restorationSubtype: "removable/dentures/flexible" });
    expect(key).toBeTruthy();
    const previous = await db.query.organizations.findFirst({ where: eq(organizations.id, labOrgId) });
    const tierName = rid("ArchTier");
    const [tier] = await db.insert(pricingTiers).values({ labOrganizationId: labOrgId, name: tierName, pricesJson: { [key!]: 825 } }).returning();
    try {
      await db.update(organizations).set({ defaultDoctorTierName: tierName }).where(eq(organizations.id, labOrgId));
      // Older archives use a historical label; editing keeps its row identity and arch.
      await db.update(caseRestorations).set({ restorationType: "Full denture" }).where(eq(caseRestorations.id, upper));
      const changed = await send({ creates: [], updates: [{ restorationId: upper, toothNumber: "", restorationType: "Denture", arch: "upper", material: "Flexible", restorationSubtype: "removable/dentures/flexible", shade: "A2" }], deletes: [], bridgeConnectors: null });
      expect(changed.status, JSON.stringify(changed.body)).toBe(200);
      expect(Number((await db.query.invoices.findFirst({ where: eq(invoices.id, invoice.id) })).total)).toBe(1550);
      const reopened = await request(appMod.default).get(`/api/cases/${caseId}`).set("Authorization", `Bearer ${access}`).expect(200);
      expect(reopened.body.data.restorations).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: upper, arch: "upper", quantity: 1, restorationType: "Denture", material: "Flexible", shade: "A2" }),
        expect.objectContaining({ id: coping, restorationType: "Coping" }),
      ]));
      const invalid = await send({ creates: [{ localId: randomUUID(), restorationType: "Denture", toothNumber: "1-16", arch: "upper", material: "Acrylic", quantity: 16, unitPrice: 500 }], updates: [], deletes: [coping], bridgeConnectors: null });
      expect(invalid.status).toBe(400);
      expect(Number((await db.query.invoices.findFirst({ where: eq(invoices.id, invoice.id) })).total)).toBe(1550);
      expect(await db.query.caseRestorations.findFirst({ where: eq(caseRestorations.id, coping) })).toBeTruthy();
      await send({ creates: [{ localId: randomUUID(), restorationType: "missing", toothNumber: "2" }], updates: [], deletes: [upper, coping], bridgeConnectors: null }).expect(200);
      expect(Number((await db.query.invoices.findFirst({ where: eq(invoices.id, invoice.id) })).total)).toBe(650);
    } finally {
      await db.update(organizations).set({ defaultDoctorTierName: previous.defaultDoctorTierName }).where(eq(organizations.id, labOrgId));
      await db.delete(pricingTiers).where(eq(pricingTiers.id, tier.id));
    }
  });

  it("persists connector off/on and rebuilds bridge invoice descriptions without changing assignments", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseId = await createCase(access);
    const { randomUUID } = await import("node:crypto");
    const { parseConnectorState, updateConnectorChoices } = await import("@workspace/case-taxonomy");
    const send = (body: object) => request(appMod.default).patch(`/api/cases/${caseId}/tooth-chart`)
      .set("Authorization", `Bearer ${access}`).send(body);
    await send({ creates: [2, 3, 4].map((n) => ({ localId: randomUUID(), toothNumber: String(n),
      restorationType: n === 3 ? "Pontic" : "Crown", material: "Zirconia", shade: "A2", unitPrice: n === 3 ? 80 : 100 })),
    updates: [], deletes: [], bridgeConnectors: "2-3,3-4" }).expect(200);
    const { db, cases, caseRestorations, invoices, invoiceLineItems } = dbMod as any;
    const before = await db.select().from(caseRestorations).where(eq(caseRestorations.caseId, caseId));
    const invoice = await db.query.invoices.findFirst({ where: eq(invoices.caseId, caseId) });
    const off = updateConnectorChoices(parseConnectorState("2-3,3-4"), new Set(["3-4"]));
    await send({ creates: [], updates: [], deletes: [], bridgeConnectors: off }).expect(200);
    expect((await db.query.cases.findFirst({ where: eq(cases.id, caseId) })).bridgeConnectors).toBe(off);
    const splitLines = await db.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, invoice.id));
    expect(splitLines.map((line: any) => line.description).join("|")).not.toMatch(/#2[–-]4/);
    const on = updateConnectorChoices(parseConnectorState(off), new Set(["2-3", "3-4"]));
    await send({ creates: [], updates: [], deletes: [], bridgeConnectors: on }).expect(200);
    expect(await db.select().from(caseRestorations).where(eq(caseRestorations.caseId, caseId))).toEqual(before);
    expect(Number((await db.query.invoices.findFirst({ where: eq(invoices.id, invoice.id) })).total)).toBe(280);
    const finalLines = await db.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, invoice.id));
    expect(finalLines.map((line: any) => line.description).join("|")).toMatch(/bridge/i);
  });

  it("atomically saves a crown-pontic-crown bridge, veneer and nonbillable missing status with an idempotent invoice", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseId = await createCase(access);
    const { randomUUID } = await import("node:crypto");
    const creates = [
      { localId: randomUUID(), toothNumber: "2", restorationType: "Crown", material: "Zirconia", shade: "A2", unitPrice: 100 },
      { localId: randomUUID(), toothNumber: "3", restorationType: "Pontic", material: "Zirconia", shade: "A2", unitPrice: 80 },
      { localId: randomUUID(), toothNumber: "4", restorationType: "Crown", material: "Zirconia", shade: "A2", unitPrice: 100 },
      { localId: randomUUID(), toothNumber: "8", restorationType: "Veneer", material: "e.max", shade: "A1", unitPrice: 60 },
      { localId: randomUUID(), toothNumber: "9", restorationType: "missing" },
    ];
    const body = { creates, updates: [], deletes: [], bridgeConnectors: "2-3,3-4" };
    const save = () => request(appMod.default).patch(`/api/cases/${caseId}/tooth-chart`)
      .set("Authorization", `Bearer ${access}`).send(body);
    const first = await save();
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    await save().expect(200);
    const { db, caseRestorations, invoices, invoiceLineItems } = dbMod as any;
    const rows = await db.select().from(caseRestorations).where(eq(caseRestorations.caseId, caseId));
    expect(rows).toHaveLength(5);
    const invoice = await db.query.invoices.findFirst({ where: eq(invoices.caseId, caseId) });
    expect(Number(invoice.total)).toBe(340);
    const lines = await db.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, invoice.id));
    expect(lines.reduce((sum: number, row: any) => sum + Number(row.lineTotal), 0)).toBe(340);
    expect(JSON.stringify(lines)).toMatch(/bridge/i);
    expect(lines.some((line: any) => line.caseRestorationId === creates[4].localId ||
      line.sourceRestorationIdsJson?.includes(creates[4].localId))).toBe(false);
    const replace = await request(appMod.default).patch(`/api/cases/${caseId}/tooth-chart`)
      .set("Authorization", `Bearer ${access}`).send({
        creates: [{ localId: randomUUID(), toothNumber: "4", restorationType: "missing" }],
        updates: [], deletes: [creates[2].localId], bridgeConnectors: "2-3",
      });
    expect(replace.status, JSON.stringify(replace.body)).toBe(200);
    const reopened = await request(appMod.default).get(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${access}`).expect(200);
    expect(reopened.body.data.restorations).toHaveLength(5);
    expect(reopened.body.data.restorations.find((row: any) => row.toothNumber === "4").restorationType).toBe("missing");
    expect(Number((await db.query.invoices.findFirst({ where: eq(invoices.id, invoice.id) })).total)).toBe(240);
  });

  it("rolls back chart deletes and invoice changes on an invalid assignment or protected invoice", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseId = await createCase(access);
    const { randomUUID } = await import("node:crypto");
    const id = randomUUID();
    await request(appMod.default).patch(`/api/cases/${caseId}/tooth-chart`)
      .set("Authorization", `Bearer ${access}`).send({
        creates: [{ localId: id, toothNumber: "2", restorationType: "Crown", material: "Zirconia", shade: "A2", unitPrice: 100 }],
        updates: [], deletes: [], bridgeConnectors: null,
      }).expect(200);
    const { db, caseRestorations, invoices, invoiceLineItems } = dbMod as any;
    const invoice = await db.query.invoices.findFirst({ where: eq(invoices.caseId, caseId) });
    const originalLines = await db.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, invoice.id));
    const broken = {
      creates: [{ localId: randomUUID(), toothNumber: "3", restorationType: "Crown", material: "" }],
      updates: [], deletes: [id], bridgeConnectors: null,
    };
    await request(appMod.default).patch(`/api/cases/${caseId}/tooth-chart`)
      .set("Authorization", `Bearer ${access}`).send(broken).expect(400);
    for (const protection of [
      { status: "paid", balanceDue: "0.00" },
      { status: "open", balanceDue: "100.00", displayMetadataJson: { reviewedCharges: true } },
    ]) {
      await db.update(invoices).set(protection).where(eq(invoices.id, invoice.id));
      await request(appMod.default).patch(`/api/cases/${caseId}/tooth-chart`)
        .set("Authorization", `Bearer ${access}`)
        .send({ creates: [], updates: [], deletes: [id], bridgeConnectors: null }).expect(409);
    }
    expect(await db.select().from(caseRestorations).where(eq(caseRestorations.caseId, caseId)))
      .toEqual(expect.arrayContaining([expect.objectContaining({ id, toothNumber: "2", unitPrice: "100.00" })]));
    expect(await db.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, invoice.id))).toEqual(originalLines);
    expect(Number((await db.query.invoices.findFirst({ where: eq(invoices.id, invoice.id) })).total)).toBe(100);
  });

  it("keeps shade-only chart edits row-scoped and refuses a provider viewer's financial write", async () => {
    const owner = await makeSession(labOwnerId);
    const viewer = await makeSession(providerUserId);
    const caseId = await createCase(owner.access);
    const { randomUUID } = await import("node:crypto");
    const id = randomUUID();
    const endpoint = `/api/cases/${caseId}/tooth-chart`;
    await request(appMod.default).patch(endpoint).set("Authorization", `Bearer ${owner.access}`).send({
      creates: [{ localId: id, toothNumber: "8", restorationType: "Veneer", material: "e.max",
        restorationSubtype: "restorative/crown_and_bridge/emax", shade: "A1", unitPrice: 60 }],
      updates: [], deletes: [], bridgeConnectors: null,
    }).expect(200);
    const change = { creates: [], updates: [{ restorationId: id, toothNumber: "8", shade: "B1" }], deletes: [], bridgeConnectors: null };
    await request(appMod.default).patch(endpoint).set("Authorization", `Bearer ${viewer.access}`).send(change).expect(403);
    await request(appMod.default).patch(endpoint).set("Authorization", `Bearer ${owner.access}`).send(change).expect(200);
    const { db, caseRestorations, invoices } = dbMod as any;
    const row = await db.query.caseRestorations.findFirst({ where: eq(caseRestorations.id, id) });
    expect(row).toMatchObject({ id, shade: "B1", restorationType: "Veneer", unitPrice: "60.00",
      restorationSubtype: "restorative/crown_and_bridge/emax", priceSource: "manual" });
    expect(Number((await db.query.invoices.findFirst({ where: eq(invoices.caseId, caseId) })).total)).toBe(60);
  });

  it("rolls back a late invoice review refusal and reprices a product change through the current lab/practice catalog", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseId = await createCase(access);
    const { randomUUID } = await import("node:crypto");
    const id = randomUUID();
    const endpoint = `/api/cases/${caseId}/tooth-chart`;
    const send = (body: Record<string, unknown>) => request(appMod.default).patch(endpoint).set("Authorization", `Bearer ${access}`).send(body);
    await send({ creates: [{ localId: id, toothNumber: "2", restorationType: "Crown", material: "Zirconia", unitPrice: 100 }],
      updates: [], deletes: [], bridgeConnectors: null }).expect(200);
    const { db, caseRestorations, invoices, organizations, pricingTiers } = dbMod as any;
    const invoice = await db.query.invoices.findFirst({ where: eq(invoices.caseId, caseId) });
    // Valid individual tooth syntax, but the final clinical/invoice check must
    // reject an unsupported isolated pontic after the tentative insert.
    await send({ creates: [{ localId: randomUUID(), toothNumber: "8", restorationType: "Pontic", material: "Zirconia", unitPrice: 80 }],
      updates: [], deletes: [], bridgeConnectors: null }).expect(409);
    expect(await db.select().from(caseRestorations).where(eq(caseRestorations.caseId, caseId))).toHaveLength(1);
    expect(Number((await db.query.invoices.findFirst({ where: eq(invoices.id, invoice.id) })).total)).toBe(100);
    const { resolveRestorationPriceKey } = await import("../lib/restoration-pricing.js");
    const key = await resolveRestorationPriceKey({ labOrganizationId: labOrgId, material: "e.max", restorationType: "Veneer" });
    expect(key).toBeTruthy();
    const previous = await db.query.organizations.findFirst({ where: eq(organizations.id, labOrgId) });
    const tierName = rid("ChartTier");
    const [tier] = await db.insert(pricingTiers).values({ labOrganizationId: labOrgId, name: tierName,
      pricesJson: { [key!]: 175 } }).returning();
    try {
      await db.update(organizations).set({ defaultDoctorTierName: tierName }).where(eq(organizations.id, labOrgId));
      const updated = await send({ creates: [], updates: [{ restorationId: id, toothNumber: "2",
        restorationType: "Veneer", material: "e.max" }], deletes: [], bridgeConnectors: null });
      expect(updated.status, JSON.stringify(updated.body)).toBe(200);
      const row = await db.query.caseRestorations.findFirst({ where: eq(caseRestorations.id, id) });
      expect(row).toMatchObject({ restorationType: "Veneer", material: "e.max", unitPrice: "175.00", priceSource: "tier" });
      expect(Number((await db.query.invoices.findFirst({ where: eq(invoices.id, invoice.id) })).total)).toBe(175);
    } finally {
      await db.update(organizations).set({ defaultDoctorTierName: previous.defaultDoctorTierName }).where(eq(organizations.id, labOrgId));
      await db.delete(pricingTiers).where(eq(pricingTiers.id, tier.id));
    }
  });

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-rst-subtype";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    await (await import("./index.js")).labtraxRoutesReady;
    authLib = await import("../lib/auth.js");

    const { db, users, organizations, organizationMemberships } = dbMod as any;

    await db.insert(users).values({
      id: labOwnerId,
      username: `rstsubtypeowner_${labOwnerId}`,
      password: "x",
    });
    await db.insert(users).values({ id: providerUserId, username: rid("provider"), password: "x", userType: "provider" });
    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: rid("RstSubtypeLab") },
      {
        id: providerOrgId,
        type: "provider",
        name: rid("RstSubtypeProv"),
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
    await db.insert(organizationMemberships).values({ id: rid("m"), labId: providerOrgId, userId: providerUserId, role: "owner", status: "active", joinedAt: new Date() });
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const {
      db,
      cases,
      caseRestorations,
      invoices,
      caseEvents,
      auditLogs,
      users,
      organizations,
      organizationMemberships,
      userSessions,
    } = dbMod as any;

    if (createdCaseIds.length > 0) {
      await db
        .delete(caseRestorations)
        .where(inArray(caseRestorations.caseId, createdCaseIds));
      await db
        .delete(caseEvents)
        .where(inArray(caseEvents.caseId, createdCaseIds));
      await db
        .delete(invoices)
        .where(inArray(invoices.caseId, createdCaseIds));
      await db
        .delete(cases)
        .where(inArray(cases.id, createdCaseIds));
    }
    await db
      .delete(auditLogs)
      .where(inArray(auditLogs.organizationId, [labOrgId, providerOrgId]));
    await db
      .delete(organizationMemberships)
      .where(inArray(organizationMemberships.userId, [labOwnerId, providerUserId]));
    await db
      .delete(organizations)
      .where(inArray(organizations.id, [labOrgId, providerOrgId]));
    await db.delete(userSessions).where(inArray(userSessions.userId, [labOwnerId, providerUserId]));
    await db.delete(users).where(inArray(users.id, [labOwnerId, providerUserId]));
  });

  // ── POST /api/cases with restorationSubtype ────────────────────────────────
  it("lets authorized viewers read implant details and the shared template without granting writes", async () => {
    const owner = await makeSession(labOwnerId);
    const viewer = await makeSession(providerUserId);
    const caseId = await createCase(owner.access);
    const added = await request(appMod.default).post(`/api/cases/${caseId}/restorations`).set("Authorization", `Bearer ${owner.access}`)
      .send({ toothNumber: "14", restorationType: "Crown", material: "Zirconia", restorationSubtype: "restorative/implant/zirconia", implantManufacturer: "Straumann" }).expect(201);
    const rowId = added.body.data.id;
    const read = await request(appMod.default).get(`/api/cases/${caseId}`).set("Authorization", `Bearer ${viewer.access}`).expect(200);
    expect(read.body.data.restorations[0].implantManufacturer).toBe("Straumann");
    const template = { version: 2, elements: [
      { id: "patient-custom", kind: "patient", x: 73, y: 42, w: 230, h: 70, visible: false, fontFamily: "Georgia", fontSize: 21 },
      { id: "notes-custom", kind: "implantPlatformNotes", page: 2, x: 50, y: 40, w: 400, h: 180, visible: true, fontFamily: "Georgia", fontSize: 19, italic: true },
    ] };
    await request(appMod.default).put(`/api/organizations/${labOrgId}/case-print-template`).set("Authorization", `Bearer ${owner.access}`).send({ template }).expect(200);
    const saved = await request(appMod.default).get(`/api/organizations/${labOrgId}/case-print-template?caseId=${caseId}`).set("Authorization", `Bearer ${viewer.access}`).expect(200);
    expect(saved.body.data.template.elements).toEqual(expect.arrayContaining(template.elements));
    await request(appMod.default).patch(`/api/cases/${caseId}/restorations/${rowId}`).set("Authorization", `Bearer ${viewer.access}`).send({ implantManufacturer: "Other" }).expect(403);
    await request(appMod.default).put(`/api/organizations/${labOrgId}/case-print-template`).set("Authorization", `Bearer ${viewer.access}`).send({ template }).expect(403);
  });

  it("persists independent implant details on create, reload and row saves without changing invoices", async () => {
    const { access } = await makeSession(labOwnerId);
    const created = await request(appMod.default).post("/api/cases").set("Authorization", `Bearer ${access}`).send({
      caseNumber: rid("IMPLANT"), labOrganizationId: labOrgId, providerOrganizationId: providerOrgId,
      patientFirstName: "Implant", patientLastName: "Details", doctorName: "Dr. Implant",
      restorations: [
        { toothNumber: "14", restorationType: "Implant", restorationSubtype: "restorative/implant", implantRetention: "Screw retained", implantManufacturer: "Straumann", implantPlatformNotes: "RC", unitPrice: 75 },
        { toothNumber: "15", restorationType: "Implant", restorationSubtype: "restorative/implant", implantRetention: "Cementable", implantManufacturer: "Other", implantPlatformNotes: "WB", unitPrice: 90 },
        { toothNumber: "16", restorationType: "Crown", material: "Zirconia", unitPrice: 30 },
      ],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const caseId = created.body.data.id as string;
    createdCaseIds.push(caseId);
    const read = () => request(appMod.default).get(`/api/cases/${caseId}`).set("Authorization", `Bearer ${access}`);
    const initial = await read();
    expect(initial.status).toBe(200);
    const rows = initial.body.data.restorations;
    const first = rows.find((row: any) => row.toothNumber === "14");
    const second = rows.find((row: any) => row.toothNumber === "15");
    expect(first).toMatchObject({ implantRetention: "Screw retained", implantManufacturer: "Straumann", implantPlatformNotes: "RC" });
    expect(second).toMatchObject({ implantRetention: "Cementable", implantManufacturer: "Other", implantPlatformNotes: "WB" });
    expect(rows.find((row: any) => row.toothNumber === "16").implantManufacturer).toBeNull();
    const { db, invoices, invoiceLineItems } = dbMod as any;
    const invoiceBefore = await db.query.invoices.findFirst({ where: eq(invoices.caseId, caseId) });
    const linesBefore = await db.query.invoiceLineItems.findMany({ where: eq(invoiceLineItems.invoiceId, invoiceBefore.id) });
    const patch = (body: object) => request(appMod.default).patch(`/api/cases/${caseId}/restorations/${first.id}`).set("Authorization", `Bearer ${access}`).send(body);
    expect((await patch({ implantPlatformNotes: "RN" })).status).toBe(200);
    expect((await read()).body.data.restorations.find((row: any) => row.id === first.id)).toMatchObject({ implantManufacturer: "Straumann", implantRetention: "Screw retained", implantPlatformNotes: "RN", unitPrice: first.unitPrice });
    expect((await read()).body.data.restorations.find((row: any) => row.id === second.id)).toMatchObject({ implantPlatformNotes: "WB", implantManufacturer: "Other" });
    expect(await db.query.invoices.findFirst({ where: eq(invoices.id, invoiceBefore.id) })).toEqual(invoiceBefore);
    expect(await db.query.invoiceLineItems.findMany({ where: eq(invoiceLineItems.invoiceId, invoiceBefore.id) })).toEqual(linesBefore);
    expect((await patch({ implantManufacturer: "Not a manufacturer" })).status).toBe(400);
    expect((await patch({ implantRetention: "screw" })).status).toBe(400);
    expect((await patch({ implantManufacturer: null })).status).toBe(200);
    expect((await patch({ shade: "A2", material: "Zirconia", restorationType: "Crown", restorationSubtype: "restorative/crown_and_bridge/zirconia" })).status).toBe(200);
    // A confirmed tooth keeps its clinical role; Implant is its product SKU.
    expect((await patch({ restorationType: "Crown", restorationSubtype: "restorative/implant/zirconia" })).status).toBe(200);
    expect((await read()).body.data.restorations.find((row: any) => row.id === first.id)).toMatchObject({ implantManufacturer: null, implantPlatformNotes: "RN", implantRetention: "Screw retained", shade: "A2" });
    const hierarchy = await request(appMod.default).patch(`/api/cases/${caseId}/restorations/hierarchy`).set("Authorization", `Bearer ${access}`).send({
      restorationType: "Crown", restorationSubtype: null, material: "", shade: "B2",
    });
    expect(hierarchy.status, JSON.stringify(hierarchy.body)).toBe(200);
    const reconciled = (await read()).body.data.restorations;
    expect(reconciled.find((row: any) => row.id === first.id).implantPlatformNotes).toBe("RN");
    expect(reconciled.find((row: any) => row.id === second.id).implantPlatformNotes).toBe("WB");
  });

  it("supports row additions and rejects implant edits outside the authorized lab", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseId = await createCase(access);
    const added = await request(appMod.default).post(`/api/cases/${caseId}/restorations`).set("Authorization", `Bearer ${access}`).send({
      toothNumber: "29", restorationType: "Implant", restorationSubtype: "restorative/implant", implantManufacturer: "Implant Direct", implantRetention: "Cementable", implantPlatformNotes: "4 mm",
    });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect(added.body.data).toMatchObject({ implantManufacturer: "Implant Direct", implantPlatformNotes: "4 mm" });
    const unauthenticated = await request(appMod.default).patch(`/api/cases/${caseId}/restorations/${added.body.data.id}`).send({ implantPlatformNotes: "not permitted" });
    expect([401, 403]).toContain(unauthenticated.status);
    const saved = await request(appMod.default).get(`/api/cases/${caseId}`).set("Authorization", `Bearer ${access}`);
    expect(saved.body.data.restorations.find((row: any) => row.id === added.body.data.id).implantPlatformNotes).toBe("4 mm");
  });

  it("POST /api/cases with restorationSubtype stores and returns the field (201)", async () => {
    const { access } = await makeSession(labOwnerId);
    const subtypeKey = "restorative/crown_and_bridge/zirconia";

    const r = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber: rid("RST-CREATE"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Create",
        patientLastName: "Subtype",
        doctorName: "Dr. Synthetic026",
        restorations: [
          {
            toothNumber: "14",
            restorationType: "Crown",
            material: "Zirconia",
            restorationSubtype: subtypeKey,
            quantity: 1,
          },
        ],
      });

    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const caseId = r.body.data.id as string;
    createdCaseIds.push(caseId);

    const get = await request(appMod.default)
      .get(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${access}`);
    expect(get.status).toBe(200);

    const restorations: any[] = get.body.data.restorations ?? [];
    expect(restorations).toHaveLength(1);
    expect(restorations[0].restorationSubtype).toBe(subtypeKey);
  });

  it("POST /api/cases with restorationSubtype persists the field in the DB", async () => {
    const { access } = await makeSession(labOwnerId);
    const subtypeKey = "restorative/implant/emax";

    const r = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber: rid("RST-DB"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "DbCheck",
        patientLastName: "Subtype",
        doctorName: "Dr. DbSubtype",
        restorations: [
          {
            toothNumber: "19",
            restorationType: "Implant Crown",
            material: "Emax",
            restorationSubtype: subtypeKey,
            quantity: 1,
          },
        ],
      });

    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const caseId = r.body.data.id as string;
    createdCaseIds.push(caseId);

    const { db, caseRestorations } = dbMod as any;
    const rows = await db
      .select()
      .from(caseRestorations)
      .where(eq(caseRestorations.caseId, caseId));

    expect(rows).toHaveLength(1);
    expect(rows[0].restorationSubtype).toBe(subtypeKey);
  });

  // ── POST /api/cases/:id/restorations with restorationSubtype ──────────────

  it("POST /api/cases/:id/restorations with restorationSubtype returns the field (201)", async () => {
    const { access } = await makeSession(labOwnerId);
    const subtypeKey = "restorative/crown_and_bridge/pfm";
    const caseId = await createCase(access);

    const r = await request(appMod.default)
      .post(`/api/cases/${caseId}/restorations`)
      .set("Authorization", `Bearer ${access}`)
      .send({
        toothNumber: "8",
        restorationType: "Crown",
        material: "PFM",
        restorationSubtype: subtypeKey,
        quantity: 1,
      });

    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.restorationSubtype).toBe(subtypeKey);
  });

  it("POST /api/cases/:id/restorations with restorationSubtype persists the field in the DB", async () => {
    const { access } = await makeSession(labOwnerId);
    const subtypeKey = "removable/dentures/acrylic";
    const caseId = await createCase(access);

    const r = await request(appMod.default)
      .post(`/api/cases/${caseId}/restorations`)
      .set("Authorization", `Bearer ${access}`)
      .send({
        toothNumber: "",
        restorationType: "Full Denture",
        material: "Acrylic",
        restorationSubtype: subtypeKey,
        quantity: 1,
        arch: "upper",
      });

    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const restorationId = r.body.data.id as string;

    const { db, caseRestorations } = dbMod as any;
    const rows = await db
      .select()
      .from(caseRestorations)
      .where(eq(caseRestorations.id, restorationId));

    expect(rows).toHaveLength(1);
    expect(rows[0].restorationSubtype).toBe(subtypeKey);
  });

  // ── PATCH /api/cases/:id/restorations/:id clears restorationSubtype ───────

  it("PATCH /api/cases/:id/restorations/:id with restorationSubtype: null clears the field (200)", async () => {
    const { access } = await makeSession(labOwnerId);
    const subtypeKey = "ortho/night_guards/night_guard_hard";
    const caseId = await createCase(access);

    const addR = await request(appMod.default)
      .post(`/api/cases/${caseId}/restorations`)
      .set("Authorization", `Bearer ${access}`)
      .send({
        toothNumber: "",
        restorationType: "Night Guard",
        restorationSubtype: subtypeKey,
        quantity: 1,
        arch: "upper",
      });

    expect(addR.status, JSON.stringify(addR.body)).toBe(201);
    const restorationId = addR.body.data.id as string;

    expect(addR.body.data.restorationSubtype).toBe(subtypeKey);

    const patchR = await request(appMod.default)
      .patch(`/api/cases/${caseId}/restorations/${restorationId}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ restorationSubtype: null });

    expect(patchR.status, JSON.stringify(patchR.body)).toBe(200);
    expect(patchR.body.data.restorationSubtype).toBeNull();
  });

  it("GET /api/cases/:id after clearing restorationSubtype reflects null", async () => {
    const { access } = await makeSession(labOwnerId);
    const subtypeKey = "restorative/temporaries/resin";
    const caseId = await createCase(access);

    const addR = await request(appMod.default)
      .post(`/api/cases/${caseId}/restorations`)
      .set("Authorization", `Bearer ${access}`)
      .send({
        toothNumber: "10",
        restorationType: "Temporary Crown",
        material: "Resin",
        restorationSubtype: subtypeKey,
        quantity: 1,
      });

    expect(addR.status, JSON.stringify(addR.body)).toBe(201);
    const restorationId = addR.body.data.id as string;

    await request(appMod.default)
      .patch(`/api/cases/${caseId}/restorations/${restorationId}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ restorationSubtype: null });

    const getR = await request(appMod.default)
      .get(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${access}`);

    expect(getR.status).toBe(200);
    const restorations: any[] = getR.body.data.restorations ?? [];
    const row = restorations.find((r: any) => r.id === restorationId);
    expect(row).toBeDefined();
    expect(row.restorationSubtype).toBeNull();
  });

  it("updates every case restoration through one hierarchy request", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseId = await createCase(access);
    const { db, caseRestorations } = dbMod as any;

    await db.insert(caseRestorations).values([
      { caseId, toothNumber: "8", restorationType: "Crown", unitPrice: "20.00" },
      { caseId, toothNumber: "9", restorationType: "Crown", unitPrice: "20.00" },
    ]);

    const response = await request(appMod.default)
      .patch(`/api/cases/${caseId}/restorations/hierarchy`)
      .set("Authorization", `Bearer ${access}`)
      .send({
        restorationType: "Crown & Bridge",
        restorationSubtype: "restorative/crown_and_bridge/zirconia",
        material: "Zirconia",
      });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data).toEqual(expect.objectContaining({
      updatedCount: 2,
      createdCount: 0,
      deletedCount: 0,
      invoiceAction: "updated",
    }));

    const rows = await db
      .select()
      .from(caseRestorations)
      .where(eq(caseRestorations.caseId, caseId));
    expect(rows).toHaveLength(2);
    expect(rows.map((row: any) => row.restorationType)).toEqual([
      "Crown",
      "Crown",
    ]);
    expect(rows.map((row: any) => row.restorationSubtype)).toEqual([
      "restorative/crown_and_bridge/zirconia",
      "restorative/crown_and_bridge/zirconia",
    ]);
  });

  it("creates both arch rows as part of the case hierarchy update", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseId = await createCase(access);
    const { db, caseRestorations } = dbMod as any;

    await db.insert(caseRestorations).values([
      { caseId, toothNumber: "", restorationType: "Crown", unitPrice: "20.00" },
      { caseId, toothNumber: "", restorationType: "Crown", unitPrice: "20.00" },
    ]);

    const response = await request(appMod.default)
      .patch(`/api/cases/${caseId}/restorations/hierarchy`)
      .set("Authorization", `Bearer ${access}`)
      .send({
        restorationType: "Full Denture",
        restorationSubtype: "removable/dentures/acrylic",
        material: "Acrylic",
        arch: "upper_lower",
      });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data).toEqual(expect.objectContaining({
      updatedCount: 2,
      createdCount: 2,
      deletedCount: 0,
      invoiceAction: "updated",
    }));

    const rows = await db
      .select()
      .from(caseRestorations)
      .where(eq(caseRestorations.caseId, caseId));
    expect(rows).toHaveLength(4);
    expect(rows.every((row: any) => row.restorationType === "Full Denture")).toBe(true);
    expect(rows.filter((row: any) => row.arch === "upper")).toHaveLength(2);
    expect(rows.filter((row: any) => row.arch === "lower")).toHaveLength(2);
  });

  it("leaves all restorations unchanged if one row cannot enter the requested hierarchy", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseId = await createCase(access);
    const { db, caseRestorations } = dbMod as any;

    await db.insert(caseRestorations).values([
      {
        caseId,
        toothNumber: "",
        restorationType: "Crown",
        arch: "upper",
      },
      {
        caseId,
        toothNumber: "",
        restorationType: "Crown",
      },
    ]);

    const response = await request(appMod.default)
      .patch(`/api/cases/${caseId}/restorations/hierarchy`)
      .set("Authorization", `Bearer ${access}`)
      .send({
        restorationType: "Full Denture",
        restorationSubtype: null,
        material: null,
      });

    expect(response.status).toBe(400);
    const rows = await db
      .select()
      .from(caseRestorations)
      .where(eq(caseRestorations.caseId, caseId));
    expect(rows).toHaveLength(2);
    expect(rows.every((row: any) => row.restorationType === "Crown")).toBe(true);
    expect(rows.map((row: any) => row.arch)).toEqual(["upper", null]);
  });

  it("switches to Removable without losing arches, quantities, notes, shades, or manual prices", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseId = await createCase(access);
    const { db, caseRestorations } = dbMod as any;
    await db.insert(caseRestorations).values([
      {
        caseId,
        toothNumber: "",
        restorationType: "Crown",
        arch: "upper",
        quantity: 2,
        notes: "upper lab note",
        shade: "A3",
        unitPrice: "83.00",
        priceSource: "manual",
        priceSourceName: "Manual entry",
      },
      {
        caseId,
        toothNumber: "",
        restorationType: "Crown",
        arch: "lower",
        quantity: 1,
        notes: "lower lab note",
        shade: "B2",
        unitPrice: "40.00",
      },
    ]);

    const response = await request(appMod.default)
      .patch(`/api/cases/${caseId}/restorations/hierarchy`)
      .set("Authorization", `Bearer ${access}`)
      .send({
        restorationType: "Full Denture",
        restorationSubtype: "removable/dentures/acrylic",
        material: "Acrylic",
        toothNumbers: [""],
      });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.manualPriceCount).toBe(1);
    const rows = await db
      .select()
      .from(caseRestorations)
      .where(eq(caseRestorations.caseId, caseId));
    expect(rows).toHaveLength(2);
    const upper = rows.find((row: any) => row.arch === "upper");
    const lower = rows.find((row: any) => row.arch === "lower");
    expect(upper).toMatchObject({
      quantity: 2,
      notes: "upper lab note",
      shade: "A3",
      unitPrice: "83.00",
      priceSource: "manual",
    });
    expect(lower).toMatchObject({
      quantity: 1,
      notes: "lower lab note",
      shade: "B2",
    });
  });

  it("creates tier-priced restoration rows and an invoice when intake produced none", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseId = await createCase(access);
    const { db, caseRestorations, invoices, pricingTiers, organizations } = dbMod as any;
    await db.delete(invoices).where(eq(invoices.caseId, caseId));
    const tierName = rid("ClinicalTier");
    const { resolveRestorationPriceKey } = await import("../lib/restoration-pricing.js");
    const priceKey = await resolveRestorationPriceKey({
      labOrganizationId: labOrgId,
      material: "Zirconia",
      restorationType: "Crown",
    });
    expect(priceKey).toBeTruthy();
    await db.insert(pricingTiers).values({
      labOrganizationId: labOrgId,
      name: tierName,
      pricesJson: { [priceKey!]: 140 },
    });
    await db.update(organizations)
      .set({ defaultDoctorTierName: tierName })
      .where(eq(organizations.id, labOrgId));

    for (const toothNumber of ["8", "9"]) {
      await request(appMod.default).post(`/api/cases/${caseId}/restorations`)
        .set("Authorization", `Bearer ${access}`)
        .send({ toothNumber, restorationType: "Crown", material: "Zirconia", shade: "A2", quantity: 1 })
        .expect(201);
    }
    const response = await request(appMod.default)
      .patch(`/api/cases/${caseId}/restorations/hierarchy`)
      .set("Authorization", `Bearer ${access}`)
      .send({
        restorationType: "Crown",
        restorationSubtype: null,
        material: "Zirconia",
        toothNumbers: ["8", "9"],
        shade: "A2",
      });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data).toMatchObject({
      createdCount: 0,
      updatedCount: 2,
      unpricedCount: 0,
      invoiceAction: "created",
    });
    const rows = await db
      .select()
      .from(caseRestorations)
      .where(eq(caseRestorations.caseId, caseId));
    expect(rows).toHaveLength(2);
    expect(rows.map((row: any) => row.unitPrice)).toEqual(["140.00", "140.00"]);
    expect(rows.every((row: any) => row.priceSource === "tier")).toBe(true);
    const invoice = await db.query.invoices.findFirst({
      where: eq(invoices.caseId, caseId),
    });
    expect(invoice).toBeTruthy();
    expect(invoice.status).toBe("open");
    expect(Number(invoice.subtotal)).toBe(280);
  });

  it("flags reviewed invoice charges for review without rebuilding them", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseId = await createCase(access);
    const { db, caseRestorations, invoices } = dbMod as any;
    await db.insert(caseRestorations).values({
      caseId,
      toothNumber: "8",
      restorationType: "Crown",
      unitPrice: "25.00",
    });
    const beforeInvoice = await db.query.invoices.findFirst({
      where: eq(invoices.caseId, caseId),
    });
    await db.update(invoices).set({
      displayMetadataJson: { reviewedCharges: true },
      subtotal: "55.00",
      total: "55.00",
      balanceDue: "55.00",
    }).where(eq(invoices.id, beforeInvoice.id));

    const response = await request(appMod.default)
      .patch(`/api/cases/${caseId}/restorations/hierarchy`)
      .set("Authorization", `Bearer ${access}`)
      .send({
        restorationType: "Crown & Bridge",
        restorationSubtype: null,
        material: "Zirconia",
        toothNumbers: ["8"],
      });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.invoiceAction).toBe("needs_review");
    const invoice = await db.query.invoices.findFirst({
      where: eq(invoices.id, beforeInvoice.id),
    });
    expect(invoice.subtotal).toBe("55.00");
    expect(invoice.displayMetadataJson).toMatchObject({
      reviewedCharges: true,
      reviewedChargesNeedsReview: true,
    });
  });

  it("leaves a paid invoice unchanged after the case hierarchy changes", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseId = await createCase(access);
    const { db, caseRestorations, invoices } = dbMod as any;
    await db.insert(caseRestorations).values({
      caseId,
      toothNumber: "8",
      restorationType: "Crown",
      unitPrice: "25.00",
    });
    const beforeInvoice = await db.query.invoices.findFirst({
      where: eq(invoices.caseId, caseId),
    });
    await db.update(invoices).set({
      status: "paid",
      subtotal: "55.00",
      total: "55.00",
      balanceDue: "0.00",
    }).where(eq(invoices.id, beforeInvoice.id));

    const response = await request(appMod.default)
      .patch(`/api/cases/${caseId}/restorations/hierarchy`)
      .set("Authorization", `Bearer ${access}`)
      .send({
        restorationType: "Crown & Bridge",
        restorationSubtype: null,
        material: "Zirconia",
        toothNumbers: ["8"],
      });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.invoiceAction).toBe("skipped");
    const invoice = await db.query.invoices.findFirst({
      where: eq(invoices.id, beforeInvoice.id),
    });
    expect(invoice.status).toBe("paid");
    expect(invoice.subtotal).toBe("55.00");
    expect(invoice.total).toBe("55.00");
  });
});
