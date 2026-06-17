/**
 * Integration tests for GET/POST/PATCH/DELETE /api/vocabulary (regression guard).
 *
 * Skipped when DATABASE_URL is not configured. All inserted rows are removed
 * in afterAll so the suite is safe to run against a shared dev DB.
 *
 * Coverage:
 *  - GET /api/vocabulary — returns default + custom items merged
 *  - GET /api/vocabulary — returns 400 for invalid kind
 *  - GET /api/vocabulary — returns 400 when labOrganizationId is missing
 *  - POST /api/vocabulary — creates a new custom item (201)
 *  - POST /api/vocabulary — item appears in subsequent GET
 *  - POST /api/vocabulary — deduplicates case-insensitively (returns 200, same id)
 *  - POST /api/vocabulary — returns existing default (200, isDefault: true)
 *  - POST /api/vocabulary — returns 400 for blank value
 *  - POST /api/vocabulary — returns 400 for invalid kind
 *  - PATCH /api/vocabulary/:id — renames item; new value appears in GET
 *  - PATCH /api/vocabulary/:id — 409 when new name collides with existing custom item
 *  - PATCH /api/vocabulary/:id — 409 when new name collides with a default
 *  - PATCH /api/vocabulary/:id — 403 for non-admin lab member
 *  - PATCH /api/vocabulary/:id — 404 for unknown id
 *  - DELETE /api/vocabulary/:id — removes item; no longer appears in GET
 *  - DELETE /api/vocabulary/:id — 403 for non-admin lab member
 *  - DELETE /api/vocabulary/:id — 404 for unknown id
 *  - Unauthenticated requests return 401
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
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
  caseMediaDir: path.join(require("os").tmpdir(), "labtrax-test-media-vocabulary"),
  extractMediaFileName: () => null,
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("Vocabulary (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let cryptoLib: typeof import("../lib/crypto.js");

  const adminId = rid("u");
  const staffId = rid("u");
  const labOrgId = rid("org");

  let accessToken: string;
  let staffToken: string;

  beforeAll(async () => {
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    cryptoLib = await import("../lib/crypto.js");

    const { db, organizations, users, organizationMemberships } = dbMod;

    await db.insert(organizations).values({
      id: labOrgId,
      name: "Vocabulary Test Lab",
      type: "lab",
    });

    const hash = await cryptoLib.hashPassword("password123");
    await db.insert(users).values({
      id: adminId,
      username: `vocabtest_${adminId}`,
      email: `${adminId}@test.example`,
      password: hash,
      firstName: "Vocab",
      lastName: "Tester",
      userType: "lab",
      role: "admin",
    });

    await db.insert(users).values({
      id: staffId,
      username: `vocabstaff_${staffId}`,
      email: `${staffId}@test.example`,
      password: hash,
      firstName: "Vocab",
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

    const loginRes = await request(appMod.default)
      .post("/api/auth/login")
      .send({ username: `vocabtest_${adminId}`, password: "password123" });
    accessToken = loginRes.body.accessToken;

    const staffLoginRes = await request(appMod.default)
      .post("/api/auth/login")
      .send({ username: `vocabstaff_${staffId}`, password: "password123" });
    staffToken = staffLoginRes.body.accessToken;
  });

  afterAll(async () => {
    if (!dbMod) return;
    const { db, labVocabulary, organizations, users, organizationMemberships } = dbMod;
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

  describe("GET /api/vocabulary", () => {
    it("returns default material list", async () => {
      const res = await request(appMod.default)
        .get(`/api/vocabulary?kind=material&labOrganizationId=${labOrgId}`)
        .set("Authorization", `Bearer ${accessToken}`);

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      const values: string[] = res.body.data.map((v: any) => v.value);
      expect(values).toContain("Zirconia");
      expect(values).toContain("PFM");
      expect(values).toContain("E.max");
      expect(values).toContain("Other");
      const defaults = res.body.data.filter((v: any) => v.isDefault);
      expect(defaults.length).toBeGreaterThan(0);
    });

    it("returns default shade list", async () => {
      const res = await request(appMod.default)
        .get(`/api/vocabulary?kind=shade&labOrganizationId=${labOrgId}`)
        .set("Authorization", `Bearer ${accessToken}`);

      expect(res.status).toBe(200);
      const values: string[] = res.body.data.map((v: any) => v.value);
      expect(values).toContain("A1");
      expect(values).toContain("B2");
      expect(values).toContain("BL1");
    });

    it("returns default restoration_type list", async () => {
      const res = await request(appMod.default)
        .get(`/api/vocabulary?kind=restoration_type&labOrganizationId=${labOrgId}`)
        .set("Authorization", `Bearer ${accessToken}`);

      expect(res.status).toBe(200);
      const values: string[] = res.body.data.map((v: any) => v.value);
      expect(values).toContain("Crown");
      expect(values).toContain("Bridge");
      expect(values).toContain("Other");
    });

    it("returns 400 for invalid kind", async () => {
      const res = await request(appMod.default)
        .get(`/api/vocabulary?kind=invalid&labOrganizationId=${labOrgId}`)
        .set("Authorization", `Bearer ${accessToken}`);

      expect(res.status).toBe(400);
    });

    it("returns 400 when labOrganizationId is missing", async () => {
      const res = await request(appMod.default)
        .get("/api/vocabulary?kind=material")
        .set("Authorization", `Bearer ${accessToken}`);

      expect(res.status).toBe(400);
    });

    it("returns 401 without auth", async () => {
      const res = await request(appMod.default)
        .get(`/api/vocabulary?kind=material&labOrganizationId=${labOrgId}`);

      expect(res.status).toBe(401);
    });
  });

  describe("POST /api/vocabulary", () => {
    it("creates a new custom material and returns 201", async () => {
      const uniqueValue = `TestMat_${rid("m")}`;
      const res = await request(appMod.default)
        .post("/api/vocabulary")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ kind: "material", value: uniqueValue, labOrganizationId: labOrgId });

      expect(res.status).toBe(201);
      expect(res.body.ok).toBe(true);
      expect(res.body.data.value).toBe(uniqueValue);
      expect(res.body.data.isDefault).toBe(false);
    });

    it("appears in subsequent GET after creation", async () => {
      const uniqueValue = `GetAfter_${rid("g")}`;
      await request(appMod.default)
        .post("/api/vocabulary")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ kind: "material", value: uniqueValue, labOrganizationId: labOrgId });

      const listRes = await request(appMod.default)
        .get(`/api/vocabulary?kind=material&labOrganizationId=${labOrgId}`)
        .set("Authorization", `Bearer ${accessToken}`);

      const values: string[] = listRes.body.data.map((v: any) => v.value);
      expect(values).toContain(uniqueValue);
    });

    it("deduplicates case-insensitively — returns existing row (200, same id)", async () => {
      const uniqueValue = `Dedup_${rid("d")}`;
      const first = await request(appMod.default)
        .post("/api/vocabulary")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ kind: "shade", value: uniqueValue, labOrganizationId: labOrgId });
      expect(first.status).toBe(201);

      const second = await request(appMod.default)
        .post("/api/vocabulary")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ kind: "shade", value: uniqueValue.toLowerCase(), labOrganizationId: labOrgId });
      expect(second.status).toBe(200);
      expect(second.body.data.id).toBe(first.body.data.id);
    });

    it("returns default item (200, isDefault: true) when value matches a default", async () => {
      const res = await request(appMod.default)
        .post("/api/vocabulary")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ kind: "material", value: "zirconia", labOrganizationId: labOrgId });

      expect(res.status).toBe(200);
      expect(res.body.data.value).toBe("Zirconia");
      expect(res.body.data.isDefault).toBe(true);
    });

    it("returns 400 for blank value", async () => {
      const res = await request(appMod.default)
        .post("/api/vocabulary")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ kind: "material", value: "   ", labOrganizationId: labOrgId });

      expect(res.status).toBe(400);
    });

    it("returns 400 for invalid kind", async () => {
      const res = await request(appMod.default)
        .post("/api/vocabulary")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ kind: "unknown", value: "test", labOrganizationId: labOrgId });

      expect(res.status).toBe(400);
    });

    it("returns 401 without auth", async () => {
      const res = await request(appMod.default)
        .post("/api/vocabulary")
        .send({ kind: "material", value: "test", labOrganizationId: labOrgId });

      expect(res.status).toBe(401);
    });
  });

  describe("PATCH /api/vocabulary/:id", () => {
    it("renames the item and the new value appears in GET", async () => {
      const original = `PatchMe_${rid("p")}`;
      const renamed = `Renamed_${rid("r")}`;

      const createRes = await request(appMod.default)
        .post("/api/vocabulary")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ kind: "material", value: original, labOrganizationId: labOrgId });
      expect(createRes.status).toBe(201);
      const id = createRes.body.data.id as string;

      const patchRes = await request(appMod.default)
        .patch(`/api/vocabulary/${id}`)
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ value: renamed });

      expect(patchRes.status).toBe(200);
      expect(patchRes.body.ok).toBe(true);
      expect(patchRes.body.data.value).toBe(renamed);
      expect(patchRes.body.data.id).toBe(id);

      const listRes = await request(appMod.default)
        .get(`/api/vocabulary?kind=material&labOrganizationId=${labOrgId}`)
        .set("Authorization", `Bearer ${accessToken}`);
      const values: string[] = listRes.body.data.map((v: any) => v.value);
      expect(values).toContain(renamed);
      expect(values).not.toContain(original);
    });

    it("returns 409 when new name collides with an existing custom item", async () => {
      const nameA = `ColA_${rid("a")}`;
      const nameB = `ColB_${rid("b")}`;

      const createA = await request(appMod.default)
        .post("/api/vocabulary")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ kind: "shade", value: nameA, labOrganizationId: labOrgId });
      expect(createA.status).toBe(201);

      const createB = await request(appMod.default)
        .post("/api/vocabulary")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ kind: "shade", value: nameB, labOrganizationId: labOrgId });
      expect(createB.status).toBe(201);
      const idB = createB.body.data.id as string;

      const patchRes = await request(appMod.default)
        .patch(`/api/vocabulary/${idB}`)
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ value: nameA });

      expect(patchRes.status).toBe(409);
    });

    it("returns 409 when new name collides with a default", async () => {
      const original = `NotADefault_${rid("nd")}`;

      const createRes = await request(appMod.default)
        .post("/api/vocabulary")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ kind: "material", value: original, labOrganizationId: labOrgId });
      expect(createRes.status).toBe(201);
      const id = createRes.body.data.id as string;

      const patchRes = await request(appMod.default)
        .patch(`/api/vocabulary/${id}`)
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ value: "Zirconia" });

      expect(patchRes.status).toBe(409);
    });

    it("returns 403 for a non-admin lab member", async () => {
      const value = `StaffPatch_${rid("sp")}`;

      const createRes = await request(appMod.default)
        .post("/api/vocabulary")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ kind: "material", value, labOrganizationId: labOrgId });
      expect(createRes.status).toBe(201);
      const id = createRes.body.data.id as string;

      const patchRes = await request(appMod.default)
        .patch(`/api/vocabulary/${id}`)
        .set("Authorization", `Bearer ${staffToken}`)
        .send({ value: `StaffRenamed_${rid("sr")}` });

      expect(patchRes.status).toBe(403);
    });

    it("returns 404 for an unknown id", async () => {
      const res = await request(appMod.default)
        .patch("/api/vocabulary/00000000-0000-0000-0000-000000000000")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ value: "AnythingNew" });

      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /api/vocabulary/:id", () => {
    it("removes the item so it no longer appears in GET", async () => {
      const value = `DeleteMe_${rid("dm")}`;

      const createRes = await request(appMod.default)
        .post("/api/vocabulary")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ kind: "restoration_type", value, labOrganizationId: labOrgId });
      expect(createRes.status).toBe(201);
      const id = createRes.body.data.id as string;

      const deleteRes = await request(appMod.default)
        .delete(`/api/vocabulary/${id}`)
        .set("Authorization", `Bearer ${accessToken}`);

      expect(deleteRes.status).toBe(200);
      expect(deleteRes.body.ok).toBe(true);
      expect(deleteRes.body.data.deleted).toBe(true);

      const listRes = await request(appMod.default)
        .get(`/api/vocabulary?kind=restoration_type&labOrganizationId=${labOrgId}`)
        .set("Authorization", `Bearer ${accessToken}`);
      const values: string[] = listRes.body.data.map((v: any) => v.value);
      expect(values).not.toContain(value);
    });

    it("returns 403 for a non-admin lab member", async () => {
      const value = `StaffDel_${rid("sd")}`;

      const createRes = await request(appMod.default)
        .post("/api/vocabulary")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ kind: "material", value, labOrganizationId: labOrgId });
      expect(createRes.status).toBe(201);
      const id = createRes.body.data.id as string;

      const deleteRes = await request(appMod.default)
        .delete(`/api/vocabulary/${id}`)
        .set("Authorization", `Bearer ${staffToken}`);

      expect(deleteRes.status).toBe(403);
    });

    it("returns 404 for an unknown id", async () => {
      const res = await request(appMod.default)
        .delete("/api/vocabulary/00000000-0000-0000-0000-000000000000")
        .set("Authorization", `Bearer ${accessToken}`);

      expect(res.status).toBe(404);
    });

    it("counts legacy mobile cases that reference the term in caseData", async () => {
      const value = `LegacyMat_${rid("lm")}`;
      const { db, labCases } = dbMod;

      const legacyCaseId = rid("lc");
      await db.insert(labCases).values({
        id: legacyCaseId,
        ownerId: adminId,
        organizationId: labOrgId,
        caseData: JSON.stringify({
          id: legacyCaseId,
          ownerId: adminId,
          restorations: [
            { toothNumber: "8", restorationType: "Crown", material: value, shade: "A2" },
            // Case-insensitive match should also count.
            { toothNumber: "9", restorationType: "Crown", material: value.toLowerCase(), shade: "A2" },
          ],
        }),
      });

      const createRes = await request(appMod.default)
        .post("/api/vocabulary")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ kind: "material", value, labOrganizationId: labOrgId });
      expect(createRes.status).toBe(201);
      const id = createRes.body.data.id as string;

      // Without force, deletion is blocked and the count reflects legacy usage.
      const blockedRes = await request(appMod.default)
        .delete(`/api/vocabulary/${id}`)
        .set("Authorization", `Bearer ${accessToken}`);
      expect(blockedRes.status).toBe(409);
      expect(blockedRes.body.usageCount).toBe(2);

      // Soft-deleted legacy cases are not counted.
      await db
        .update(labCases)
        .set({ deletedAt: new Date() })
        .where(eq(labCases.id, legacyCaseId));

      const allowedRes = await request(appMod.default)
        .delete(`/api/vocabulary/${id}`)
        .set("Authorization", `Bearer ${accessToken}`);
      expect(allowedRes.status).toBe(200);
      expect(allowedRes.body.data.usageCount).toBe(0);

      await db.delete(labCases).where(eq(labCases.id, legacyCaseId));
    });
  });
});
