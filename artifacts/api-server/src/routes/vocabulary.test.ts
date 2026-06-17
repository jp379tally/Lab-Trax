/**
 * Integration tests for GET/POST /api/vocabulary (regression guard).
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
  const labOrgId = rid("org");

  let accessToken: string;

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

    await db.insert(organizationMemberships).values({
      labId: labOrgId,
      userId: adminId,
      role: "admin",
      status: "active",
    });

    const loginRes = await request(appMod.default)
      .post("/api/auth/login")
      .send({ username: `vocabtest_${adminId}`, password: "password123" });
    accessToken = loginRes.body.accessToken;
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
    await db.delete(organizations).where(eq(organizations.id, labOrgId));
    await db.delete(users).where(eq(users.id, adminId));
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
});
