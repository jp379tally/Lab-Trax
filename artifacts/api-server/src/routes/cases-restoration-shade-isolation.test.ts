/**
 * Regression suite: per-restoration shade edits stay isolated.
 *
 * The desktop Lab Slip edits one shade per restoration row through
 * PATCH /api/cases/:caseId/restorations/:restorationId. The whole point of
 * that targeted write is that setting tooth 4 to A2 must not disturb tooth 29,
 * and must not rewrite the edited row's identity, tooth number, type, material
 * or price. A regression there silently corrupts billing and the Rx.
 *
 * Protected behaviors:
 *   (1) A shade-only PATCH changes just that restoration's shade; its sibling
 *       and all of its own other columns are untouched.
 *   (2) Two shade edits on the same case keep both values distinct on GET
 *       /api/cases/:id (what the drawer refetches after a save).
 *   (3) An empty shade clears the column to NULL instead of being ignored.
 *   (4) A nonstandard shade string is stored verbatim, not normalized away.
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
  caseMediaDir: path.join(os.tmpdir(), "labtrax-test-media-rst-shade"),
  extractMediaFileName: () => null,
  extractMediaFilenamesFromText: () => [],
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

/** Matches the pre-provenance desktop parser/formatter in ToothChart. */
function legacyDesktopSerialize(value: string): string {
  const pairs = new Set<string>();
  for (const token of value.split(",")) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    const [a, b] = trimmed.split("-").map((part) => part.trim());
    if (!a || !b) continue;
    const na = Number(a);
    const nb = Number(b);
    pairs.add(Number.isFinite(na) && Number.isFinite(nb)
      ? (na < nb ? `${na}-${nb}` : `${nb}-${na}`)
      : (a < b ? `${a}-${b}` : `${b}-${a}`));
  }
  return [...pairs].sort().join(",");
}

maybe("per-restoration shade isolation (db integration)", () => {
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
    return { access: authLib.signAccessToken(userId, sessionId) };
  }

  /** A two-tooth case shaped like an AI-intake result: tooth 4 A1, tooth 29 B1. */
  async function createTwoToothCase(access: string): Promise<{
    caseId: string;
    tooth4Id: string;
    tooth29Id: string;
  }> {
    const r = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber: rid("SHADE"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Shade",
        patientLastName: rid("Pat"),
        doctorName: "Dr. Synthetic062",
        status: "received",
        restorations: [
          {
            toothNumber: "4",
            restorationType: "Crown",
            material: "Zirconia",
            shade: "A1",
            quantity: 1,
            unitPrice: 120,
          },
          {
            toothNumber: "29",
            restorationType: "Crown",
            material: "Emax",
            shade: "B1",
            quantity: 1,
            unitPrice: 140,
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
    const tooth4 = rows.find((row: any) => row.toothNumber === "4");
    const tooth29 = rows.find((row: any) => row.toothNumber === "29");
    expect(tooth4, "tooth 4 restoration").toBeDefined();
    expect(tooth29, "tooth 29 restoration").toBeDefined();
    return { caseId, tooth4Id: tooth4.id, tooth29Id: tooth29.id };
  }

  /**
   * A denture case holding the two durable rows the server creates for an
   * "Upper + Lower" appliance: same type, arch upper and lower, one shade.
   */
  async function createLinkedArchCase(access: string): Promise<{
    caseId: string;
    upperId: string;
    lowerId: string;
  }> {
    const created = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber: rid("ARCH"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Arch",
        patientLastName: rid("Pat"),
        doctorName: "Dr. Synthetic062",
        status: "received",
        restorations: [
          {
            toothNumber: "",
            restorationType: "Full Denture",
            material: "Acrylic",
            shade: "A2",
            arch: "upper",
            quantity: 1,
            unitPrice: 500,
          },
        ],
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const caseId = created.body.data.id as string;
    createdCaseIds.push(caseId);

    const { db, caseRestorations } = dbMod as any;
    const [seed] = await db
      .select()
      .from(caseRestorations)
      .where(eq(caseRestorations.caseId, caseId));
    expect(seed, "seed denture restoration").toBeDefined();

    // Let the server own the Upper + Lower transition, so the pair is exactly
    // what production holds rather than two hand-inserted rows.
    const paired = await request(appMod.default)
      .patch(`/api/cases/${caseId}/restorations/${seed.id}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ arch: "upper_lower" });
    expect(paired.status, JSON.stringify(paired.body)).toBe(200);

    const rows = await db
      .select()
      .from(caseRestorations)
      .where(eq(caseRestorations.caseId, caseId));
    const upper = rows.find((row: any) => row.arch === "upper");
    const lower = rows.find((row: any) => row.arch === "lower");
    expect(upper, "upper arch row").toBeDefined();
    expect(lower, "lower arch row").toBeDefined();
    return { caseId, upperId: upper.id, lowerId: lower.id };
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-rst-shade";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    await (await import("./index.js")).labtraxRoutesReady;
    authLib = await import("../lib/auth.js");

    const { db, users, organizations, organizationMemberships } = dbMod as any;

    await db.insert(users).values({
      id: labOwnerId,
      username: `rstshadeowner_${labOwnerId}`,
      password: "x",
    });
    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: rid("RstShadeLab") },
      {
        id: providerOrgId,
        type: "provider",
        name: rid("RstShadeProv"),
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
      await db.delete(invoices).where(inArray(invoices.caseId, createdCaseIds));
      await db.delete(cases).where(inArray(cases.id, createdCaseIds));
    }
    await db
      .delete(auditLogs)
      .where(inArray(auditLogs.organizationId, [labOrgId, providerOrgId]));
    await db
      .delete(organizationMemberships)
      .where(eq(organizationMemberships.userId, labOwnerId));
    await db
      .delete(organizations)
      .where(inArray(organizations.id, [labOrgId, providerOrgId]));
    await db.delete(userSessions).where(eq(userSessions.userId, labOwnerId));
    await db.delete(users).where(eq(users.id, labOwnerId));
  });

  it("a shade-only PATCH leaves the sibling restoration and every other column alone", async () => {
    const { access } = await makeSession(labOwnerId);
    const { caseId, tooth4Id, tooth29Id } = await createTwoToothCase(access);
    const { db, caseRestorations } = dbMod as any;

    const before = await db
      .select()
      .from(caseRestorations)
      .where(eq(caseRestorations.caseId, caseId));
    const before4 = before.find((row: any) => row.id === tooth4Id);
    const before29 = before.find((row: any) => row.id === tooth29Id);

    const patch = await request(appMod.default)
      .patch(`/api/cases/${caseId}/restorations/${tooth4Id}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ shade: "A2" });
    expect(patch.status, JSON.stringify(patch.body)).toBe(200);
    expect(patch.body.data.shade).toBe("A2");

    const after = await db
      .select()
      .from(caseRestorations)
      .where(eq(caseRestorations.caseId, caseId));
    const after4 = after.find((row: any) => row.id === tooth4Id);
    const after29 = after.find((row: any) => row.id === tooth29Id);

    // The edited row keeps its identity and everything the shade edit did not
    // mention.
    expect(after4.id).toBe(before4.id);
    expect(after4.toothNumber).toBe("4");
    expect(after4.restorationType).toBe(before4.restorationType);
    expect(after4.material).toBe(before4.material);
    expect(after4.unitPrice).toBe(before4.unitPrice);
    expect(after4.quantity).toBe(before4.quantity);
    expect(after4.shade).toBe("A2");

    // The sibling is byte-for-byte what it was.
    expect(after29).toEqual(before29);
  });

  it("persists the #2–4 topology, disconnect choices and manual correction provenance", async () => {
    const { access } = await makeSession(labOwnerId);
    const response = await request(appMod.default).post("/api/cases").set("Authorization", `Bearer ${access}`).send({
      caseNumber: rid("CN"), labOrganizationId: labOrgId, providerOrganizationId: providerOrgId,
      patientFirstName: "Tooth", patientLastName: rid("Bridge"), doctorName: "Dr. Workflow", status: "received",
      restorations: ["Crown", "Pontic", "Crown"].map((restorationType, index) => ({
        toothNumber: String(index + 2), restorationType, material: "Zirconia", shade: "A2", quantity: 1,
        unitPrice: 100, assignmentProvenance: { origin: "ai_explicit", roleEvidence: index === 1 ? "Pontic #3" : `Prepared crown #${index + 2}`, manualFields: [] },
      })),
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const caseId = response.body.data.id; createdCaseIds.push(caseId);
    const get = () => request(appMod.default).get(`/api/cases/${caseId}`).set("Authorization", `Bearer ${access}`);
    const saved = (await get()).body.data;
    expect(saved.bridgeConnectors.split(",").sort()).toEqual(["?2-3", "?3-4"]);
    expect(saved.restorations.map((row: any) => row.quantity)).toEqual([1, 1, 1]);
    const pontic = saved.restorations.find((row: any) => row.toothNumber === "3");
    expect(legacyDesktopSerialize("?2-3")).toBe("3-?2");
    expect(legacyDesktopSerialize("!2-3")).toBe("!2-3");

    // An unrelated case edit accompanied by marker values echoed by the old
    // parser must leave canonical suggestion provenance untouched.
    const unrelatedEdit = await request(appMod.default)
      .patch(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${access}`)
      .send({
        doctorName: "Dr. Legacy Desktop",
        bridgeConnectors: legacyDesktopSerialize(saved.bridgeConnectors),
      });
    expect(unrelatedEdit.status, JSON.stringify(unrelatedEdit.body)).toBe(200);
    const afterUnrelatedEdit = (await get()).body.data;
    expect(afterUnrelatedEdit.bridgeConnectors).toBe("?2-3,?3-4");
    expect(afterUnrelatedEdit.doctorName).toBe("Dr. Legacy Desktop");

    // The old chart treats ?2-3 as an opaque key. Toggling its visible 2-3
    // connector therefore sends both the echoed marker and the plain edge.
    const legacyAdd = legacyDesktopSerialize("?2-3,?3-4,2-3");
    expect(legacyAdd).toBe("2-3,3-?2,4-?3");
    const addConnector = () => request(appMod.default)
      .patch(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ bridgeConnectors: legacyAdd });
    expect((await addConnector()).status).toBe(200);
    expect((await addConnector()).status).toBe(200); // retries are idempotent
    expect((await get()).body.data.bridgeConnectors.split(",").sort()).toEqual(["2-3", "?3-4"]);
    expect((await get()).body.data.bridgeConnectors).not.toContain("3-?");

    const removeConnector = await request(appMod.default)
      .patch(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ bridgeConnectors: legacyDesktopSerialize("?3-4") });
    expect(removeConnector.status, JSON.stringify(removeConnector.body)).toBe(200);
    expect((await get()).body.data.bridgeConnectors).toBe("?3-4");

    const seedOff = await request(appMod.default)
      .patch(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ bridgeConnectors: legacyDesktopSerialize("!2-3,?4-5") });
    // A malformed marker is not accepted as a new value unless the matching
    // canonical marker already exists.
    expect(seedOff.status).toBe(400);
    const setOff = await request(appMod.default)
      .patch(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ bridgeConnectors: "!2-3,?3-4" });
    expect(setOff.status, JSON.stringify(setOff.body)).toBe(200);
    const preserveOff = await request(appMod.default)
      .patch(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ doctorName: "Dr. Off Marker Echo", bridgeConnectors: legacyDesktopSerialize("!2-3,?3-4") });
    expect(preserveOff.status, JSON.stringify(preserveOff.body)).toBe(200);
    const afterOffEcho = (await get()).body.data;
    expect(afterOffEcho.bridgeConnectors).toBe("!2-3,?3-4");
    expect(afterOffEcho.doctorName).toBe("Dr. Off Marker Echo");

    const shade = await request(appMod.default).patch(`/api/cases/${caseId}/restorations/${pontic.id}`).set("Authorization", `Bearer ${access}`).send({ shade: "B1" });
    expect(shade.status, JSON.stringify(shade.body)).toBe(200);
    const { db, caseRestorations } = dbMod as any;
    const [source] = await db.select().from(caseRestorations).where(eq(caseRestorations.id, pontic.id));
    expect(source.assignmentProvenance).toMatchObject({ origin: "ai_explicit", manualFields: ["shade"], roleEvidence: "Pontic #3" });
    const disconnect = await request(appMod.default).patch(`/api/cases/${caseId}`).set("Authorization", `Bearer ${access}`).send({ bridgeConnectors: "!2-3,3-4" });
    expect(disconnect.status, JSON.stringify(disconnect.body)).toBe(200);
    expect((await get()).body.data.bridgeConnectors).toBe("!2-3,3-4");
    for (const invalidValue of ["2-4", "4-5", "16-17"]) {
      const invalid = await request(appMod.default)
        .patch(`/api/cases/${caseId}`)
        .set("Authorization", `Bearer ${access}`)
        .send({ bridgeConnectors: invalidValue });
      expect(invalid.status, `${invalidValue}: ${JSON.stringify(invalid.body)}`).toBe(400);
      expect(JSON.stringify(invalid.body)).toContain("Cannot save tooth connectors");
      expect((await get()).body.data.bridgeConnectors).toBe("!2-3,3-4");
    }
    const incompatibleCase = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber: rid("CN"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Incompatible",
        patientLastName: rid("Bridge"),
        doctorName: "Dr. Workflow",
        status: "received",
        restorations: [
          { toothNumber: "5", restorationType: "Crown", material: "Zirconia", shade: "A2", quantity: 1, unitPrice: 100 },
          { toothNumber: "6", restorationType: "Pontic", material: "PFM", shade: "A2", quantity: 1, unitPrice: 100 },
        ],
      });
    expect(incompatibleCase.status, JSON.stringify(incompatibleCase.body)).toBe(201);
    createdCaseIds.push(incompatibleCase.body.data.id);
    const incompatibleEdge = await request(appMod.default)
      .patch(`/api/cases/${incompatibleCase.body.data.id}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ bridgeConnectors: "5-6" });
    expect(incompatibleEdge.status).toBe(400);
    expect(JSON.stringify(incompatibleEdge.body)).toContain("Cannot save tooth connectors");
    const incompatibleAfter = await request(appMod.default)
      .get(`/api/cases/${incompatibleCase.body.data.id}`)
      .set("Authorization", `Bearer ${access}`);
    expect(incompatibleAfter.body.data.bridgeConnectors ?? null).toBeNull();
    const incompatible = await request(appMod.default).patch(`/api/cases/${caseId}/restorations/${pontic.id}`).set("Authorization", `Bearer ${access}`).send({ material: "Emax" });
    expect(incompatible.status).toBe(400);
    expect((await get()).body.data.restorations.find((row: any) => row.id === pontic.id).material).toBe("Zirconia");
    for (let attempt = 0; attempt < 2; attempt++) {
      const removed = await request(appMod.default).delete(`/api/cases/${caseId}/restorations/${pontic.id}`).set("Authorization", `Bearer ${access}`);
      expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    }
    const after = (await get()).body.data;
    expect(after.restorations).toHaveLength(2);
    expect(after.bridgeConnectors.split(",").sort()).toEqual(["!2-3", "!3-4"]);
  });

  it("replays a tooth addition without another restoration or invoice charge", async () => {
    const { access } = await makeSession(labOwnerId);
    const { caseId } = await createTwoToothCase(access);
    const payload = { toothNumber: "2", restorationType: "Crown", material: "Zirconia", shade: "A2", quantity: 1, unitPrice: 100 };
    const create = () => request(appMod.default).post(`/api/cases/${caseId}/restorations`).set("Authorization", `Bearer ${access}`).send(payload);
    expect((await create()).status).toBe(201);
    expect((await create()).status).toBe(201);
    const get = await request(appMod.default).get(`/api/cases/${caseId}`).set("Authorization", `Bearer ${access}`);
    expect(get.body.data.restorations.filter((row: any) => row.toothNumber === "2")).toHaveLength(1);
    const conflict = await request(appMod.default).post(`/api/cases/${caseId}/restorations`).set("Authorization", `Bearer ${access}`).send({ ...payload, restorationType: "Pontic" });
    expect(conflict.status).toBe(409);
  });

  it("keeps tooth 4 and tooth 29 shades distinct on the refetched case", async () => {
    const { access } = await makeSession(labOwnerId);
    const { caseId, tooth4Id, tooth29Id } = await createTwoToothCase(access);

    for (const [restorationId, shade] of [
      [tooth4Id, "A2"],
      [tooth29Id, "A1"],
    ] as const) {
      const patch = await request(appMod.default)
        .patch(`/api/cases/${caseId}/restorations/${restorationId}`)
        .set("Authorization", `Bearer ${access}`)
        .send({ shade });
      expect(patch.status, JSON.stringify(patch.body)).toBe(200);
    }

    const get = await request(appMod.default)
      .get(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${access}`);
    expect(get.status).toBe(200);

    const restorations: any[] = get.body.data.restorations ?? [];
    const tooth4 = restorations.find((row) => row.id === tooth4Id);
    const tooth29 = restorations.find((row) => row.id === tooth29Id);
    expect(tooth4.shade).toBe("A2");
    expect(tooth29.shade).toBe("A1");
    // Materials and prices survived both edits.
    expect(tooth4.material).toBe("Zirconia");
    expect(tooth29.material).toBe("Emax");
    expect(Number(tooth4.unitPrice)).toBe(120);
    expect(Number(tooth29.unitPrice)).toBe(140);
  });

  it("clears a shade when an empty value is sent", async () => {
    const { access } = await makeSession(labOwnerId);
    const { caseId, tooth4Id, tooth29Id } = await createTwoToothCase(access);

    const patch = await request(appMod.default)
      .patch(`/api/cases/${caseId}/restorations/${tooth4Id}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ shade: "" });
    expect(patch.status, JSON.stringify(patch.body)).toBe(200);
    expect(patch.body.data.shade).toBeNull();

    const get = await request(appMod.default)
      .get(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${access}`);
    const restorations: any[] = get.body.data.restorations ?? [];
    expect(restorations.find((row) => row.id === tooth4Id).shade).toBeNull();
    // Clearing one shade never clears the other.
    expect(restorations.find((row) => row.id === tooth29Id).shade).toBe("B1");
  });

  it("a row-scoped shade edit leaves the linked opposite arch alone", async () => {
    const { access } = await makeSession(labOwnerId);
    const { caseId, upperId, lowerId } = await createLinkedArchCase(access);

    // Give the arches different shades, one row at a time.
    for (const [restorationId, shade] of [
      [lowerId, "B1"],
      [upperId, "A1"],
    ] as const) {
      const patch = await request(appMod.default)
        .patch(`/api/cases/${caseId}/restorations/${restorationId}`)
        .set("Authorization", `Bearer ${access}`)
        .send({ shade, syncLinkedArch: false });
      expect(patch.status, JSON.stringify(patch.body)).toBe(200);
    }

    const get = await request(appMod.default)
      .get(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${access}`);
    const rows: any[] = get.body.data.restorations ?? [];
    const upper = rows.find((row) => row.id === upperId);
    const lower = rows.find((row) => row.id === lowerId);
    expect(upper.shade).toBe("A1");
    expect(lower.shade).toBe("B1");
    // Neither row lost its arch, type or price to the shade edits.
    expect(upper.arch).toBe("upper");
    expect(lower.arch).toBe("lower");
    expect(lower.restorationType).toBe(upper.restorationType);
    expect(Number(lower.unitPrice)).toBe(Number(upper.unitPrice));
  });

  it("clears one arch's shade without clearing the other", async () => {
    const { access } = await makeSession(labOwnerId);
    const { caseId, upperId, lowerId } = await createLinkedArchCase(access);

    const distinct = await request(appMod.default)
      .patch(`/api/cases/${caseId}/restorations/${lowerId}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ shade: "B1", syncLinkedArch: false });
    expect(distinct.status, JSON.stringify(distinct.body)).toBe(200);

    const cleared = await request(appMod.default)
      .patch(`/api/cases/${caseId}/restorations/${upperId}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ shade: "", syncLinkedArch: false });
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    expect(cleared.body.data.shade).toBeNull();

    const get = await request(appMod.default)
      .get(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${access}`);
    const rows: any[] = get.body.data.restorations ?? [];
    expect(rows.find((row) => row.id === upperId).shade).toBeNull();
    expect(rows.find((row) => row.id === lowerId).shade).toBe("B1");
  });

  it("still mirrors a shade onto the linked arch when the caller does not opt out", async () => {
    const { access } = await makeSession(labOwnerId);
    const { caseId, upperId, lowerId } = await createLinkedArchCase(access);

    // Existing linked-arch editing semantics: an appliance edited as one unit
    // keeps both of its rows in step. The row-scoped flag is the only opt-out.
    const patch = await request(appMod.default)
      .patch(`/api/cases/${caseId}/restorations/${upperId}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ shade: "C1" });
    expect(patch.status, JSON.stringify(patch.body)).toBe(200);

    const get = await request(appMod.default)
      .get(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${access}`);
    const rows: any[] = get.body.data.restorations ?? [];
    expect(rows.find((row) => row.id === upperId).shade).toBe("C1");
    expect(rows.find((row) => row.id === lowerId).shade).toBe("C1");
  });

  it("stores a nonstandard shade exactly as the lab wrote it", async () => {
    const { access } = await makeSession(labOwnerId);
    const { caseId, tooth4Id } = await createTwoToothCase(access);

    const patch = await request(appMod.default)
      .patch(`/api/cases/${caseId}/restorations/${tooth4Id}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ shade: "OM3 (Vita 3D)" });
    expect(patch.status, JSON.stringify(patch.body)).toBe(200);
    expect(patch.body.data.shade).toBe("OM3 (Vita 3D)");

    const get = await request(appMod.default)
      .get(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${access}`);
    const restorations: any[] = get.body.data.restorations ?? [];
    expect(restorations.find((row) => row.id === tooth4Id).shade).toBe(
      "OM3 (Vita 3D)",
    );
  });
});
