/**
 * Integration tests for /api/catalog (Lab Catalog — regression guard).
 *
 * Skipped when DATABASE_URL is not configured. All inserted rows are removed
 * in afterAll so the suite is safe to run against a shared dev DB.
 *
 * Coverage:
 *  - GET /api/catalog/tree — built-in tree with zero customizations (no
 *    regression for labs that never touch the feature); case-type nodes
 *    carry no id/isCustom/isActive (not independently editable rows); PFZ
 *    still resolves to the zirconia_crown price key.
 *  - GET /api/catalog/tree — 400 missing labOrganizationId; 401 unauthenticated.
 *  - POST /api/catalog/entries — add custom subtype / material (incl. under
 *    a custom subtype); appears in the effective tree; validation errors
 *    (invalid case type, parentKey misuse, unknown custom parent, blank
 *    label, entryType outside subtype|material); 403 non-admin; 401.
 *  - PATCH /api/catalog/entries/:id — rename/disable/reorder a custom entry;
 *    rejects built-ins; 403 non-admin; 404 unknown id.
 *  - PATCH /api/catalog/builtin-overrides — disable/reorder a built-in
 *    (idempotent upsert-in-place, partial updates don't reset unset
 *    fields); rejects unknown built-in keys and entryType outside
 *    subtype|material; 403 non-admin.
 *  - DELETE /api/catalog/entries/:id — usage guard (direct + transitive via
 *    a custom material child) with/without force; cascades to custom
 *    material children; rejects built-ins; 403 non-admin; 404 unknown id.
 *  - Price-key validation on create/update.
 *  - GET /api/catalog/legacy-vocabulary-review — curated term matching,
 *    case-insensitive, read-only; 403 non-admin; 401.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, createHash } from "node:crypto";
import { eq, and } from "drizzle-orm";
import request from "supertest";
import * as path from "node:path";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(require("os").tmpdir(), "labtrax-test-media-catalog"),
  extractMediaFileName: () => null,
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("Lab Catalog (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let cryptoLib: typeof import("../lib/crypto.js");
  let authLib: typeof import("../lib/auth.js");

  const adminId = rid("u");
  const staffId = rid("u");
  const labOrgId = rid("org");

  const createdCaseIds: string[] = [];

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

  async function createCaseWithRestorationSubtype(restorationSubtype: string): Promise<string> {
    const { db, cases, caseRestorations } = dbMod;
    const [createdCase] = await db
      .insert(cases)
      .values({
        caseNumber: rid("case"),
        labOrganizationId: labOrgId,
        providerOrganizationId: labOrgId,
        patientFirstName: "Catalog",
        patientLastName: "Test",
        doctorName: "Dr. Catalog",
        createdByUserId: adminId,
      })
      .returning();
    createdCaseIds.push(createdCase.id);

    await db.insert(caseRestorations).values({
      caseId: createdCase.id,
      toothNumber: "11",
      restorationType: "Crown",
      restorationSubtype,
    });

    return createdCase.id;
  }

  async function createCustomEntry(
    access: string,
    body: Record<string, unknown>,
  ) {
    return request(appMod.default)
      .post("/api/catalog/entries")
      .set("Authorization", `Bearer ${access}`)
      .send({ labOrganizationId: labOrgId, ...body });
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] = process.env["JWT_SECRET"] ?? "labtrax-test-secret-catalog";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    cryptoLib = await import("../lib/crypto.js");
    authLib = await import("../lib/auth.js");

    const { db, organizations, users, organizationMemberships } = dbMod;

    await db.insert(organizations).values({
      id: labOrgId,
      name: "Catalog Test Lab",
      type: "lab",
    });

    const hash = await cryptoLib.hashPassword("password123");
    await db.insert(users).values({
      id: adminId,
      username: `catalogtest_${adminId}`,
      email: `${adminId}@test.example`,
      password: hash,
      firstName: "Catalog",
      lastName: "Tester",
      userType: "lab",
      role: "admin",
    });

    await db.insert(users).values({
      id: staffId,
      username: `catalogstaff_${staffId}`,
      email: `${staffId}@test.example`,
      password: hash,
      firstName: "Catalog",
      lastName: "Staff",
      userType: "lab",
      role: "staff",
    });

    await db.insert(organizationMemberships).values({
      labId: labOrgId,
      userId: adminId,
      role: "admin",
      status: "active",
    });

    await db.insert(organizationMemberships).values({
      labId: labOrgId,
      userId: staffId,
      role: "staff",
      status: "active",
    });
  });

  beforeEach(async () => {
    await makeSession(adminId);
  });

  afterAll(async () => {
    if (!dbMod) return;
    const {
      db,
      labCatalogEntries,
      labVocabulary,
      organizations,
      users,
      organizationMemberships,
      cases,
      caseRestorations,
    } = dbMod;
    for (const caseId of createdCaseIds) {
      await db.delete(caseRestorations).where(eq(caseRestorations.caseId, caseId));
      await db.delete(cases).where(eq(cases.id, caseId));
    }
    await db.delete(labCatalogEntries).where(eq(labCatalogEntries.labOrganizationId, labOrgId));
    await db.delete(labVocabulary).where(eq(labVocabulary.labOrganizationId, labOrgId));
    await db.delete(organizationMemberships).where(
      and(
        eq(organizationMemberships.labId, labOrgId),
        eq(organizationMemberships.userId, adminId),
      ),
    );
    await db.delete(organizationMemberships).where(
      and(
        eq(organizationMemberships.labId, labOrgId),
        eq(organizationMemberships.userId, staffId),
      ),
    );
    await db.delete(organizations).where(eq(organizations.id, labOrgId));
    await db.delete(users).where(eq(users.id, adminId));
    await db.delete(users).where(eq(users.id, staffId));
  });

  // ─────────────────────────── GET /api/catalog/tree ─────────────────────────
  // Declared first so these assertions run before any test below adds
  // customizations for labOrgId.

  describe("GET /api/catalog/tree", () => {
    it("returns exactly today's built-in tree when the lab has zero customizations", async () => {
      const { access } = await makeSession(adminId);
      const res = await request(appMod.default)
        .get(`/api/catalog/tree?labOrganizationId=${labOrgId}`)
        .set("Authorization", `Bearer ${access}`);

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data.labOrganizationId).toBe(labOrgId);

      const { caseTypes } = res.body.data;
      expect(caseTypes.map((c: any) => c.key).sort()).toEqual([
        "ortho",
        "removable",
        "restorative",
      ]);

      const restorative = caseTypes.find((c: any) => c.key === "restorative");
      expect(restorative.label).toBe("Restorative");
      // Case types are fixed and never independently editable rows — no
      // id/isCustom/isActive on the case-type node itself.
      expect(restorative).not.toHaveProperty("id");
      expect(restorative).not.toHaveProperty("isCustom");
      expect(restorative).not.toHaveProperty("isActive");

      const crownAndBridge = restorative.subtypes.find((s: any) => s.key === "crown_and_bridge");
      expect(crownAndBridge.label).toBe("Crown & Bridge");
      expect(crownAndBridge.isCustom).toBe(false);
      expect(crownAndBridge.isActive).toBe(true);
      expect(crownAndBridge.id).toBeNull();

      const zirconia = crownAndBridge.materials.find((m: any) => m.key === "zirconia");
      expect(zirconia.priceKey).toBe("zirconia_crown");
      expect(zirconia.isCustom).toBe(false);

      // A "flat" ortho subtype with zero material children still resolves.
      const retainers = caseTypes
        .find((c: any) => c.key === "ortho")
        .subtypes.find((s: any) => s.key === "retainers");
      expect(retainers).toBeTruthy();
      expect(retainers.materials).toEqual([]);
    });

    it("resolves PFZ toward the zirconia_crown price key, not a new key", async () => {
      const { access } = await makeSession(adminId);
      const res = await request(appMod.default)
        .get(`/api/catalog/tree?labOrganizationId=${labOrgId}`)
        .set("Authorization", `Bearer ${access}`);

      const crownAndBridge = res.body.data.caseTypes
        .find((c: any) => c.key === "restorative")
        .subtypes.find((s: any) => s.key === "crown_and_bridge");
      const pfz = crownAndBridge.materials.find((m: any) => m.key === "pfz");
      expect(pfz.priceKey).toBe("zirconia_crown");
    });

    it("returns 400 when labOrganizationId is missing", async () => {
      const { access } = await makeSession(adminId);
      const res = await request(appMod.default)
        .get("/api/catalog/tree")
        .set("Authorization", `Bearer ${access}`);
      expect(res.status).toBe(400);
    });

    it("returns 401 without auth", async () => {
      const res = await request(appMod.default).get(
        `/api/catalog/tree?labOrganizationId=${labOrgId}`,
      );
      expect(res.status).toBe(401);
    });
  });

  // ────────────────────────── POST /api/catalog/entries ───────────────────────

  describe("POST /api/catalog/entries", () => {
    it("creates a custom subtype under a fixed case type and it appears in the tree", async () => {
      const { access } = await makeSession(adminId);
      const label = `Custom Subtype ${rid("cs")}`;
      const res = await createCustomEntry(access, {
        entryType: "subtype",
        caseType: "restorative",
        label,
      });

      expect(res.status).toBe(201);
      expect(res.body.ok).toBe(true);
      expect(res.body.data.isCustom).toBe(true);
      expect(res.body.data.isActive).toBe(true);
      expect(res.body.data.key).toMatch(/^custom:/);

      const treeRes = await request(appMod.default)
        .get(`/api/catalog/tree?labOrganizationId=${labOrgId}`)
        .set("Authorization", `Bearer ${access}`);
      const restorative = treeRes.body.data.caseTypes.find((c: any) => c.key === "restorative");
      const created = restorative.subtypes.find((s: any) => s.key === res.body.data.key);
      expect(created).toBeTruthy();
      expect(created.label).toBe(label);
      expect(created.materials).toEqual([]);
    });

    it("creates a custom material under a built-in subtype", async () => {
      const { access } = await makeSession(adminId);
      const label = `Custom Material ${rid("cm")}`;
      const res = await createCustomEntry(access, {
        entryType: "material",
        caseType: "restorative",
        parentKey: "crown_and_bridge",
        label,
      });

      expect(res.status).toBe(201);
      expect(res.body.data.isCustom).toBe(true);

      const treeRes = await request(appMod.default)
        .get(`/api/catalog/tree?labOrganizationId=${labOrgId}`)
        .set("Authorization", `Bearer ${access}`);
      const crownAndBridge = treeRes.body.data.caseTypes
        .find((c: any) => c.key === "restorative")
        .subtypes.find((s: any) => s.key === "crown_and_bridge");
      const created = crownAndBridge.materials.find((m: any) => m.key === res.body.data.key);
      expect(created).toBeTruthy();
      expect(created.label).toBe(label);
    });

    it("creates a custom material under a previously-created custom subtype", async () => {
      const { access } = await makeSession(adminId);
      const subtypeRes = await createCustomEntry(access, {
        entryType: "subtype",
        caseType: "removable",
        label: `Parent Subtype ${rid("ps")}`,
      });
      expect(subtypeRes.status).toBe(201);
      const parentKey = subtypeRes.body.data.key as string;

      const materialLabel = `Child Material ${rid("cmm")}`;
      const materialRes = await createCustomEntry(access, {
        entryType: "material",
        caseType: "removable",
        parentKey,
        label: materialLabel,
      });
      expect(materialRes.status).toBe(201);

      const treeRes = await request(appMod.default)
        .get(`/api/catalog/tree?labOrganizationId=${labOrgId}`)
        .set("Authorization", `Bearer ${access}`);
      const removable = treeRes.body.data.caseTypes.find((c: any) => c.key === "removable");
      const parentNode = removable.subtypes.find((s: any) => s.key === parentKey);
      expect(parentNode.materials.map((m: any) => m.label)).toContain(materialLabel);
    });

    it("defaults new sortOrder to the end of the sibling list", async () => {
      const { access } = await makeSession(adminId);
      const first = await createCustomEntry(access, {
        entryType: "subtype",
        caseType: "ortho",
        label: `Sort First ${rid("sf")}`,
      });
      const second = await createCustomEntry(access, {
        entryType: "subtype",
        caseType: "ortho",
        label: `Sort Second ${rid("ss")}`,
      });
      expect(second.body.data.sortOrder).toBeGreaterThan(first.body.data.sortOrder);
    });

    it("returns 400 for an invalid case type", async () => {
      const { access } = await makeSession(adminId);
      const res = await createCustomEntry(access, {
        entryType: "subtype",
        caseType: "not_a_case_type",
        label: "Whatever",
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 when entryType is outside subtype|material (case types are immutable)", async () => {
      const { access } = await makeSession(adminId);
      const res = await createCustomEntry(access, {
        entryType: "case_type",
        caseType: "restorative",
        label: "New Case Type",
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 when parentKey is provided for a subtype", async () => {
      const { access } = await makeSession(adminId);
      const res = await createCustomEntry(access, {
        entryType: "subtype",
        caseType: "restorative",
        parentKey: "crown_and_bridge",
        label: "Bad Subtype",
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 when parentKey is missing for a material", async () => {
      const { access } = await makeSession(adminId);
      const res = await createCustomEntry(access, {
        entryType: "material",
        caseType: "restorative",
        label: "Bad Material",
      });
      expect(res.status).toBe(400);
    });

    it("returns 404 when a material's custom parentKey does not exist", async () => {
      const { access } = await makeSession(adminId);
      const res = await createCustomEntry(access, {
        entryType: "material",
        caseType: "restorative",
        parentKey: "custom:00000000-0000-0000-0000-000000000000",
        label: "Orphan Material",
      });
      expect(res.status).toBe(404);
    });

    it("returns 400 for a blank label", async () => {
      const { access } = await makeSession(adminId);
      const res = await createCustomEntry(access, {
        entryType: "subtype",
        caseType: "restorative",
        label: "   ",
      });
      expect(res.status).toBe(400);
    });

    it("returns 403 for a non-admin lab member", async () => {
      const { access } = await makeSession(staffId);
      const res = await createCustomEntry(access, {
        entryType: "subtype",
        caseType: "restorative",
        label: "Staff Subtype",
      });
      expect(res.status).toBe(403);
    });

    it("returns 401 without auth", async () => {
      const res = await request(appMod.default)
        .post("/api/catalog/entries")
        .send({
          labOrganizationId: labOrgId,
          entryType: "subtype",
          caseType: "restorative",
          label: "No Auth",
        });
      expect(res.status).toBe(401);
    });
  });

  // ───────────────────────── PATCH /api/catalog/entries/:id ───────────────────

  describe("PATCH /api/catalog/entries/:id", () => {
    it("renames, disables, and reorders a custom entry", async () => {
      const { access } = await makeSession(adminId);
      const createRes = await createCustomEntry(access, {
        entryType: "subtype",
        caseType: "restorative",
        label: `Before Rename ${rid("br")}`,
      });
      const id = createRes.body.data.id as string;

      const renamed = `After Rename ${rid("ar")}`;
      const patchRes = await request(appMod.default)
        .patch(`/api/catalog/entries/${id}`)
        .set("Authorization", `Bearer ${access}`)
        .send({ label: renamed, isActive: false, sortOrder: 99 });

      expect(patchRes.status).toBe(200);
      expect(patchRes.body.data.label).toBe(renamed);
      expect(patchRes.body.data.isActive).toBe(false);
      expect(patchRes.body.data.sortOrder).toBe(99);

      const includeInactiveRes = await request(appMod.default)
        .get(`/api/catalog/tree?labOrganizationId=${labOrgId}&includeInactive=true`)
        .set("Authorization", `Bearer ${access}`);
      const restorativeAll = includeInactiveRes.body.data.caseTypes.find(
        (c: any) => c.key === "restorative",
      );
      expect(restorativeAll.subtypes.some((s: any) => s.key === createRes.body.data.key)).toBe(
        true,
      );

      const activeOnlyRes = await request(appMod.default)
        .get(`/api/catalog/tree?labOrganizationId=${labOrgId}&includeInactive=false`)
        .set("Authorization", `Bearer ${access}`);
      const restorativeActive = activeOnlyRes.body.data.caseTypes.find(
        (c: any) => c.key === "restorative",
      );
      expect(restorativeActive.subtypes.some((s: any) => s.key === createRes.body.data.key)).toBe(
        false,
      );
    });

    it("returns 400 when attempting to edit a built-in entry through this route", async () => {
      const { access } = await makeSession(adminId);
      const overrideRes = await request(appMod.default)
        .patch("/api/catalog/builtin-overrides")
        .set("Authorization", `Bearer ${access}`)
        .send({
          labOrganizationId: labOrgId,
          entryType: "subtype",
          caseType: "restorative",
          key: "implant",
          sortOrder: 3,
        });
      expect(overrideRes.status).toBe(200);
      const id = overrideRes.body.data.id as string;

      const patchRes = await request(appMod.default)
        .patch(`/api/catalog/entries/${id}`)
        .set("Authorization", `Bearer ${access}`)
        .send({ label: "Attempted Rename" });
      expect(patchRes.status).toBe(400);
    });

    it("returns 403 for a non-admin lab member", async () => {
      const { access: adminAccess } = await makeSession(adminId);
      const { access: staffAccess } = await makeSession(staffId);
      const createRes = await createCustomEntry(adminAccess, {
        entryType: "subtype",
        caseType: "restorative",
        label: `Staff Patch ${rid("sp")}`,
      });
      const id = createRes.body.data.id as string;

      const patchRes = await request(appMod.default)
        .patch(`/api/catalog/entries/${id}`)
        .set("Authorization", `Bearer ${staffAccess}`)
        .send({ label: "Staff Renamed" });
      expect(patchRes.status).toBe(403);
    });

    it("returns 404 for an unknown id", async () => {
      const { access } = await makeSession(adminId);
      const res = await request(appMod.default)
        .patch("/api/catalog/entries/00000000-0000-0000-0000-000000000000")
        .set("Authorization", `Bearer ${access}`)
        .send({ label: "Anything" });
      expect(res.status).toBe(404);
    });
  });

  // ───────────────────── PATCH /api/catalog/builtin-overrides ─────────────────

  describe("PATCH /api/catalog/builtin-overrides", () => {
    it("disables a built-in subtype; hidden only when includeInactive=false", async () => {
      const { access } = await makeSession(adminId);
      const patchRes = await request(appMod.default)
        .patch("/api/catalog/builtin-overrides")
        .set("Authorization", `Bearer ${access}`)
        .send({
          labOrganizationId: labOrgId,
          entryType: "subtype",
          caseType: "removable",
          key: "nesbits",
          isActive: false,
        });
      expect(patchRes.status).toBe(200);
      expect(patchRes.body.data.isActive).toBe(false);
      // Built-in labels are immutable — the server-computed label always wins.
      expect(patchRes.body.data.label).toBe("Nesbits");

      const allRes = await request(appMod.default)
        .get(`/api/catalog/tree?labOrganizationId=${labOrgId}&includeInactive=true`)
        .set("Authorization", `Bearer ${access}`);
      const removableAll = allRes.body.data.caseTypes.find((c: any) => c.key === "removable");
      const nesbitsAll = removableAll.subtypes.find((s: any) => s.key === "nesbits");
      expect(nesbitsAll).toBeTruthy();
      expect(nesbitsAll.isActive).toBe(false);

      const activeRes = await request(appMod.default)
        .get(`/api/catalog/tree?labOrganizationId=${labOrgId}&includeInactive=false`)
        .set("Authorization", `Bearer ${access}`);
      const removableActive = activeRes.body.data.caseTypes.find((c: any) => c.key === "removable");
      expect(removableActive.subtypes.some((s: any) => s.key === "nesbits")).toBe(false);
    });

    it("reorders a built-in material", async () => {
      const { access } = await makeSession(adminId);
      // -1 unambiguously beats every other sibling's default static-index
      // sortOrder (0, 1, 2) — a tie at 0 would otherwise be broken
      // alphabetically by label ("Hard" < "Soft"), masking a real reorder.
      const patchRes = await request(appMod.default)
        .patch("/api/catalog/builtin-overrides")
        .set("Authorization", `Bearer ${access}`)
        .send({
          labOrganizationId: labOrgId,
          entryType: "material",
          caseType: "ortho",
          parentKey: "night_guards",
          key: "night_guard_soft",
          sortOrder: -1,
        });
      expect(patchRes.status).toBe(200);
      expect(patchRes.body.data.sortOrder).toBe(-1);

      const treeRes = await request(appMod.default)
        .get(`/api/catalog/tree?labOrganizationId=${labOrgId}`)
        .set("Authorization", `Bearer ${access}`);
      const nightGuards = treeRes.body.data.caseTypes
        .find((c: any) => c.key === "ortho")
        .subtypes.find((s: any) => s.key === "night_guards");
      expect(nightGuards.materials[0].key).toBe("night_guard_soft");
    });

    it("upserts in place — a partial update never resets a previously-set field", async () => {
      const { access } = await makeSession(adminId);
      const first = await request(appMod.default)
        .patch("/api/catalog/builtin-overrides")
        .set("Authorization", `Bearer ${access}`)
        .send({
          labOrganizationId: labOrgId,
          entryType: "subtype",
          caseType: "restorative",
          key: "temporaries",
          sortOrder: 42,
        });
      expect(first.status).toBe(200);
      const id = first.body.data.id as string;
      expect(first.body.data.sortOrder).toBe(42);

      // Second call sets only isActive — sortOrder must remain 42 (not reset
      // to the static default index), and the same row must be reused.
      const second = await request(appMod.default)
        .patch("/api/catalog/builtin-overrides")
        .set("Authorization", `Bearer ${access}`)
        .send({
          labOrganizationId: labOrgId,
          entryType: "subtype",
          caseType: "restorative",
          key: "temporaries",
          isActive: false,
        });
      expect(second.status).toBe(200);
      expect(second.body.data.id).toBe(id);
      expect(second.body.data.sortOrder).toBe(42);
      expect(second.body.data.isActive).toBe(false);
    });

    it("returns 400 for an unknown built-in subtype key", async () => {
      const { access } = await makeSession(adminId);
      const res = await request(appMod.default)
        .patch("/api/catalog/builtin-overrides")
        .set("Authorization", `Bearer ${access}`)
        .send({
          labOrganizationId: labOrgId,
          entryType: "subtype",
          caseType: "restorative",
          key: "not_a_real_subtype",
        });
      expect(res.status).toBe(400);
    });

    it("returns 400 for a material override whose parentKey is not a built-in subtype", async () => {
      const { access } = await makeSession(adminId);
      const res = await request(appMod.default)
        .patch("/api/catalog/builtin-overrides")
        .set("Authorization", `Bearer ${access}`)
        .send({
          labOrganizationId: labOrgId,
          entryType: "material",
          caseType: "restorative",
          parentKey: "not_a_real_subtype",
          key: "zirconia",
        });
      expect(res.status).toBe(400);
    });

    it("returns 400 when entryType is outside subtype|material (case types are immutable)", async () => {
      const { access } = await makeSession(adminId);
      const res = await request(appMod.default)
        .patch("/api/catalog/builtin-overrides")
        .set("Authorization", `Bearer ${access}`)
        .send({
          labOrganizationId: labOrgId,
          entryType: "case_type",
          caseType: "restorative",
          key: "restorative",
          isActive: false,
        });
      expect(res.status).toBe(400);
    });

    it("returns 403 for a non-admin lab member", async () => {
      const { access } = await makeSession(staffId);
      const res = await request(appMod.default)
        .patch("/api/catalog/builtin-overrides")
        .set("Authorization", `Bearer ${access}`)
        .send({
          labOrganizationId: labOrgId,
          entryType: "subtype",
          caseType: "restorative",
          key: "implant",
          sortOrder: 1,
        });
      expect(res.status).toBe(403);
    });
  });

  // ───────────────────────── DELETE /api/catalog/entries/:id ──────────────────

  describe("DELETE /api/catalog/entries/:id", () => {
    it("deletes a custom entry directly when it has no references", async () => {
      const { access } = await makeSession(adminId);
      const createRes = await createCustomEntry(access, {
        entryType: "subtype",
        caseType: "ortho",
        label: `Unused ${rid("uu")}`,
      });
      const id = createRes.body.data.id as string;

      const deleteRes = await request(appMod.default)
        .delete(`/api/catalog/entries/${id}`)
        .set("Authorization", `Bearer ${access}`);
      expect(deleteRes.status).toBe(200);
      expect(deleteRes.body.data.deleted).toBe(true);
      expect(deleteRes.body.data.usageCount).toBe(0);
    });

    it("cascades to delete custom material children when deleting a custom subtype", async () => {
      const { access } = await makeSession(adminId);
      const subtypeRes = await createCustomEntry(access, {
        entryType: "subtype",
        caseType: "ortho",
        label: `Cascade Parent ${rid("cp")}`,
      });
      const parentKey = subtypeRes.body.data.key as string;
      const parentId = subtypeRes.body.data.id as string;

      const materialRes = await createCustomEntry(access, {
        entryType: "material",
        caseType: "ortho",
        parentKey,
        label: `Cascade Child ${rid("cc")}`,
      });
      const childId = materialRes.body.data.id as string;

      const deleteRes = await request(appMod.default)
        .delete(`/api/catalog/entries/${parentId}`)
        .set("Authorization", `Bearer ${access}`);
      expect(deleteRes.status).toBe(200);
      expect(deleteRes.body.data.cascadedMaterialCount).toBe(1);

      const { db, labCatalogEntries } = dbMod;
      const childRow = await db.query.labCatalogEntries.findFirst({
        where: eq(labCatalogEntries.id, childId),
      });
      expect(childRow).toBeUndefined();
    });

    it("returns 400 when attempting to delete a built-in entry", async () => {
      const { access } = await makeSession(adminId);
      const overrideRes = await request(appMod.default)
        .patch("/api/catalog/builtin-overrides")
        .set("Authorization", `Bearer ${access}`)
        .send({
          labOrganizationId: labOrgId,
          entryType: "subtype",
          caseType: "removable",
          key: "flippers",
          sortOrder: 1,
        });
      const id = overrideRes.body.data.id as string;

      const deleteRes = await request(appMod.default)
        .delete(`/api/catalog/entries/${id}`)
        .set("Authorization", `Bearer ${access}`);
      expect(deleteRes.status).toBe(400);
    });

    it("blocks deletion with a 409 + usageCount when a custom subtype is referenced by a case restoration", async () => {
      const { access } = await makeSession(adminId);
      const subtypeRes = await createCustomEntry(access, {
        entryType: "subtype",
        caseType: "restorative",
        label: `Used Subtype ${rid("us")}`,
      });
      const key = subtypeRes.body.data.key as string;
      const id = subtypeRes.body.data.id as string;

      await createCaseWithRestorationSubtype(`restorative/${key}`);

      const blockedRes = await request(appMod.default)
        .delete(`/api/catalog/entries/${id}`)
        .set("Authorization", `Bearer ${access}`);
      expect(blockedRes.status).toBe(409);
      expect(blockedRes.body.ok).toBe(false);
      expect(blockedRes.body.usageCount).toBe(1);

      const forcedRes = await request(appMod.default)
        .delete(`/api/catalog/entries/${id}?force=true`)
        .set("Authorization", `Bearer ${access}`);
      expect(forcedRes.status).toBe(200);
      expect(forcedRes.body.data.deleted).toBe(true);
      expect(forcedRes.body.data.usageCount).toBe(1);
    });

    it("counts a custom material child's usage against its parent custom subtype (prefix match)", async () => {
      const { access } = await makeSession(adminId);
      const subtypeRes = await createCustomEntry(access, {
        entryType: "subtype",
        caseType: "restorative",
        label: `Transitive Parent ${rid("tp")}`,
      });
      const parentKey = subtypeRes.body.data.key as string;
      const parentId = subtypeRes.body.data.id as string;

      const materialRes = await createCustomEntry(access, {
        entryType: "material",
        caseType: "restorative",
        parentKey,
        label: `Transitive Child ${rid("tc")}`,
      });
      const materialKey = materialRes.body.data.key as string;

      await createCaseWithRestorationSubtype(`restorative/${parentKey}/${materialKey}`);

      const blockedRes = await request(appMod.default)
        .delete(`/api/catalog/entries/${parentId}`)
        .set("Authorization", `Bearer ${access}`);
      expect(blockedRes.status).toBe(409);
      expect(blockedRes.body.usageCount).toBe(1);
    });

    it("blocks deletion of a custom material referenced directly (suffix match)", async () => {
      const { access } = await makeSession(adminId);
      const materialRes = await createCustomEntry(access, {
        entryType: "material",
        caseType: "restorative",
        parentKey: "crown_and_bridge",
        label: `Used Material ${rid("um")}`,
      });
      const materialKey = materialRes.body.data.key as string;
      const materialId = materialRes.body.data.id as string;

      await createCaseWithRestorationSubtype(`restorative/crown_and_bridge/${materialKey}`);

      const blockedRes = await request(appMod.default)
        .delete(`/api/catalog/entries/${materialId}`)
        .set("Authorization", `Bearer ${access}`);
      expect(blockedRes.status).toBe(409);
      expect(blockedRes.body.usageCount).toBe(1);
    });

    it("returns 403 for a non-admin lab member", async () => {
      const { access: adminAccess } = await makeSession(adminId);
      const { access: staffAccess } = await makeSession(staffId);
      const createRes = await createCustomEntry(adminAccess, {
        entryType: "subtype",
        caseType: "ortho",
        label: `Staff Delete ${rid("sd")}`,
      });
      const id = createRes.body.data.id as string;

      const deleteRes = await request(appMod.default)
        .delete(`/api/catalog/entries/${id}`)
        .set("Authorization", `Bearer ${staffAccess}`);
      expect(deleteRes.status).toBe(403);
    });

    it("returns 404 for an unknown id", async () => {
      const { access } = await makeSession(adminId);
      const res = await request(appMod.default)
        .delete("/api/catalog/entries/00000000-0000-0000-0000-000000000000")
        .set("Authorization", `Bearer ${access}`);
      expect(res.status).toBe(404);
    });
  });

  // ─────────────────────────── Price-key validation ───────────────────────────

  describe("price-key validation", () => {
    it("accepts a known pricing key on create", async () => {
      const { access } = await makeSession(adminId);
      const res = await createCustomEntry(access, {
        entryType: "material",
        caseType: "restorative",
        parentKey: "crown_and_bridge",
        label: `Priced Material ${rid("pm")}`,
        priceKeyOverride: "zirconia_crown",
      });
      expect(res.status).toBe(201);
      expect(res.body.data.priceKeyOverride).toBe("zirconia_crown");
    });

    it("rejects an unknown pricing key on create", async () => {
      const { access } = await makeSession(adminId);
      const res = await createCustomEntry(access, {
        entryType: "material",
        caseType: "restorative",
        parentKey: "crown_and_bridge",
        label: `Bad Price Material ${rid("bpm")}`,
        priceKeyOverride: "not_a_real_price_key",
      });
      expect(res.status).toBe(400);
    });

    it("rejects a blank-string pricing key on create", async () => {
      const { access } = await makeSession(adminId);
      const res = await createCustomEntry(access, {
        entryType: "material",
        caseType: "restorative",
        parentKey: "crown_and_bridge",
        label: `Blank Price Material ${rid("blm")}`,
        priceKeyOverride: "   ",
      });
      expect(res.status).toBe(400);
    });

    it("allows clearing a pricing key override via PATCH (null)", async () => {
      const { access } = await makeSession(adminId);
      const createRes = await createCustomEntry(access, {
        entryType: "material",
        caseType: "restorative",
        parentKey: "crown_and_bridge",
        label: `Clearable Material ${rid("cl")}`,
        priceKeyOverride: "emax_crown",
      });
      const id = createRes.body.data.id as string;

      const patchRes = await request(appMod.default)
        .patch(`/api/catalog/entries/${id}`)
        .set("Authorization", `Bearer ${access}`)
        .send({ priceKeyOverride: null });
      expect(patchRes.status).toBe(200);
      expect(patchRes.body.data.priceKeyOverride).toBeNull();
    });

    it("rejects an unknown pricing key on a built-in override", async () => {
      const { access } = await makeSession(adminId);
      const res = await request(appMod.default)
        .patch("/api/catalog/builtin-overrides")
        .set("Authorization", `Bearer ${access}`)
        .send({
          labOrganizationId: labOrgId,
          entryType: "subtype",
          caseType: "ortho",
          key: "sports_guards",
          priceKeyOverride: "not_a_real_price_key",
        });
      expect(res.status).toBe(400);
    });

    it("accepts a known pricing key on a flat (no-material) built-in subtype override", async () => {
      const { access } = await makeSession(adminId);
      const res = await request(appMod.default)
        .patch("/api/catalog/builtin-overrides")
        .set("Authorization", `Bearer ${access}`)
        .send({
          labOrganizationId: labOrgId,
          entryType: "subtype",
          caseType: "ortho",
          key: "sports_guards",
          priceKeyOverride: "sports_guard",
        });
      expect(res.status).toBe(200);
      expect(res.body.data.priceKeyOverride).toBe("sports_guard");
    });
  });

  // ────────────────────── GET /api/catalog/legacy-vocabulary-review ───────────

  describe("GET /api/catalog/legacy-vocabulary-review", () => {
    const insertedVocabIds: string[] = [];

    async function seedVocab(value: string): Promise<string> {
      const { db, labVocabulary } = dbMod;
      const [row] = await db
        .insert(labVocabulary)
        .values({ labOrganizationId: labOrgId, kind: "material", value })
        .returning();
      insertedVocabIds.push(row.id);
      return row.id;
    }

    afterAll(async () => {
      const { db, labVocabulary } = dbMod;
      for (const id of insertedVocabIds) {
        await db.delete(labVocabulary).where(eq(labVocabulary.id, id));
      }
    });

    it("surfaces curated problem terms case-insensitively, without touching real materials", async () => {
      const { access } = await makeSession(adminId);
      await seedVocab("Implant");
      await seedVocab("diagnostic wax up");
      await seedVocab("PFZ");
      const zirconiaId = await seedVocab(`Zirconia_${rid("z")}`);
      const unrelatedId = await seedVocab(`Foobar_${rid("f")}`);

      const res = await request(appMod.default)
        .get(`/api/catalog/legacy-vocabulary-review?labOrganizationId=${labOrgId}`)
        .set("Authorization", `Bearer ${access}`);

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      const values: string[] = res.body.data.map((c: any) => c.value.toLowerCase());
      expect(values).toContain("implant");
      expect(values).toContain("diagnostic wax up");
      expect(values).toContain("pfz");
      const ids: string[] = res.body.data.map((c: any) => c.id);
      expect(ids).not.toContain(zirconiaId);
      expect(ids).not.toContain(unrelatedId);

      const implantCandidate = res.body.data.find(
        (c: any) => c.value.toLowerCase() === "implant",
      );
      expect(implantCandidate.matchedTerm).toBe("Implant");
      expect(typeof implantCandidate.reason).toBe("string");
      expect(implantCandidate.reason.length).toBeGreaterThan(0);
    });

    it("never mutates lab_vocabulary — calling it twice returns identical rows", async () => {
      const { access } = await makeSession(adminId);
      const value = `Combo_${rid("c")}`;
      await seedVocab(value);

      const { db, labVocabulary } = dbMod;
      const before = await db.query.labVocabulary.findMany({
        where: eq(labVocabulary.labOrganizationId, labOrgId),
      });

      await request(appMod.default)
        .get(`/api/catalog/legacy-vocabulary-review?labOrganizationId=${labOrgId}`)
        .set("Authorization", `Bearer ${access}`);
      await request(appMod.default)
        .get(`/api/catalog/legacy-vocabulary-review?labOrganizationId=${labOrgId}`)
        .set("Authorization", `Bearer ${access}`);

      const after = await db.query.labVocabulary.findMany({
        where: eq(labVocabulary.labOrganizationId, labOrgId),
      });
      expect(after.length).toBe(before.length);
      expect(after.map((r) => r.value).sort()).toEqual(before.map((r) => r.value).sort());
    });

    it("returns 403 for a non-admin lab member", async () => {
      const { access } = await makeSession(staffId);
      const res = await request(appMod.default)
        .get(`/api/catalog/legacy-vocabulary-review?labOrganizationId=${labOrgId}`)
        .set("Authorization", `Bearer ${access}`);
      expect(res.status).toBe(403);
    });

    it("returns 401 without auth", async () => {
      const res = await request(appMod.default).get(
        `/api/catalog/legacy-vocabulary-review?labOrganizationId=${labOrgId}`,
      );
      expect(res.status).toBe(401);
    });
  });
});
