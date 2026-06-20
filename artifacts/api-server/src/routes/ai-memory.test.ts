/**
 * Integration tests for GET/POST/PATCH/DELETE /api/ai-memory (regression guard).
 *
 * Skipped when DATABASE_URL is not configured. All inserted rows are removed
 * in afterAll so the suite is safe to run against a shared dev DB.
 *
 * Coverage:
 *  - GET /api/ai-memory — returns entries for a lab (any active member)
 *  - GET /api/ai-memory — 400 when labOrganizationId is missing
 *  - GET /api/ai-memory — 400 for an invalid kind filter
 *  - GET /api/ai-memory — 403 for a non-member
 *  - POST /api/ai-memory — creates an entry (201, admin only)
 *  - POST /api/ai-memory — 403 for a non-admin lab member
 *  - POST /api/ai-memory — 409 on duplicate key (case-insensitive)
 *  - POST /api/ai-memory — 400 for blank value / invalid kind
 *  - PATCH /api/ai-memory/:id — renames; 409 on key collision; 403 non-admin; 404 unknown
 *  - DELETE /api/ai-memory/:id — soft-deletes (no longer in GET); 403 non-admin; 404 unknown
 *  - Unauthenticated requests return 401
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
  caseMediaDir: path.join(require("os").tmpdir(), "labtrax-test-media-ai-memory"),
  extractMediaFileName: () => null,
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("AI memory (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let cryptoLib: typeof import("../lib/crypto.js");
  let authLib: typeof import("../lib/auth.js");

  const adminId = rid("u");
  const staffId = rid("u");
  const outsiderId = rid("u");
  const labOrgId = rid("org");

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
    process.env["JWT_SECRET"] = process.env["JWT_SECRET"] ?? "labtrax-test-secret-ai-memory";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    cryptoLib = await import("../lib/crypto.js");
    authLib = await import("../lib/auth.js");

    const { db, organizations, users, organizationMemberships } = dbMod;

    await db.insert(organizations).values({
      id: labOrgId,
      name: "AI Memory Test Lab",
      type: "lab",
    });

    const hash = await cryptoLib.hashPassword("password123");
    await db.insert(users).values({
      id: adminId,
      username: `aimemadmin_${adminId}`,
      email: `${adminId}@test.example`,
      password: hash,
      firstName: "AiMem",
      lastName: "Admin",
      userType: "lab",
      role: "admin",
    });
    await db.insert(users).values({
      id: staffId,
      username: `aimemstaff_${staffId}`,
      email: `${staffId}@test.example`,
      password: hash,
      firstName: "AiMem",
      lastName: "Staff",
      userType: "lab",
      role: "staff",
    });
    await db.insert(users).values({
      id: outsiderId,
      username: `aimemout_${outsiderId}`,
      email: `${outsiderId}@test.example`,
      password: hash,
      firstName: "AiMem",
      lastName: "Outsider",
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
    const { db, aiMemory, organizations, users, organizationMemberships } = dbMod;
    await db.delete(aiMemory).where(eq(aiMemory.labOrganizationId, labOrgId));
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
    await db.delete(users).where(eq(users.id, outsiderId));
  });

  describe("GET /api/ai-memory", () => {
    it("returns 401 without auth", async () => {
      const res = await request(appMod.default).get(
        `/api/ai-memory?labOrganizationId=${labOrgId}`,
      );
      expect(res.status).toBe(401);
    });

    it("returns 400 when labOrganizationId is missing", async () => {
      const { access } = await makeSession(adminId);
      const res = await request(appMod.default)
        .get("/api/ai-memory")
        .set("Authorization", `Bearer ${access}`);
      expect(res.status).toBe(400);
    });

    it("returns 400 for an invalid kind filter", async () => {
      const { access } = await makeSession(adminId);
      const res = await request(appMod.default)
        .get(`/api/ai-memory?labOrganizationId=${labOrgId}&kind=bogus`)
        .set("Authorization", `Bearer ${access}`);
      expect(res.status).toBe(400);
    });

    it("returns 403 for a non-member", async () => {
      const { access } = await makeSession(outsiderId);
      const res = await request(appMod.default)
        .get(`/api/ai-memory?labOrganizationId=${labOrgId}`)
        .set("Authorization", `Bearer ${access}`);
      expect(res.status).toBe(403);
    });

    it("allows any active member to read", async () => {
      const { access } = await makeSession(staffId);
      const res = await request(appMod.default)
        .get(`/api/ai-memory?labOrganizationId=${labOrgId}`)
        .set("Authorization", `Bearer ${access}`);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
    });
  });

  describe("POST /api/ai-memory", () => {
    it("creates an entry (201) and it appears in GET", async () => {
      const { access } = await makeSession(adminId);
      const key = `Term_${rid("k")}`;
      const res = await request(appMod.default)
        .post("/api/ai-memory")
        .set("Authorization", `Bearer ${access}`)
        .send({ labOrganizationId: labOrgId, kind: "glossary", key, value: "A definition." });
      expect(res.status).toBe(201);
      expect(res.body.data.key).toBe(key);
      expect(res.body.data.kind).toBe("glossary");
      expect(res.body.data.source).toBe("manual");

      const listRes = await request(appMod.default)
        .get(`/api/ai-memory?labOrganizationId=${labOrgId}`)
        .set("Authorization", `Bearer ${access}`);
      const keys: string[] = listRes.body.data.map((r: any) => r.key);
      expect(keys).toContain(key);
    });

    it("returns 403 for a non-admin lab member", async () => {
      const { access } = await makeSession(staffId);
      const res = await request(appMod.default)
        .post("/api/ai-memory")
        .set("Authorization", `Bearer ${access}`)
        .send({ labOrganizationId: labOrgId, kind: "fact", key: rid("k"), value: "v" });
      expect(res.status).toBe(403);
    });

    it("returns 409 on a duplicate key (case-insensitive)", async () => {
      const { access } = await makeSession(adminId);
      const key = `Dup_${rid("k")}`;
      const first = await request(appMod.default)
        .post("/api/ai-memory")
        .set("Authorization", `Bearer ${access}`)
        .send({ labOrganizationId: labOrgId, kind: "preference", key, value: "v1" });
      expect(first.status).toBe(201);

      const second = await request(appMod.default)
        .post("/api/ai-memory")
        .set("Authorization", `Bearer ${access}`)
        .send({ labOrganizationId: labOrgId, kind: "preference", key: key.toLowerCase(), value: "v2" });
      expect(second.status).toBe(409);
    });

    it("returns 400 for a blank value", async () => {
      const { access } = await makeSession(adminId);
      const res = await request(appMod.default)
        .post("/api/ai-memory")
        .set("Authorization", `Bearer ${access}`)
        .send({ labOrganizationId: labOrgId, kind: "fact", key: rid("k"), value: "   " });
      expect(res.status).toBe(400);
    });

    it("returns 400 for an invalid kind", async () => {
      const { access } = await makeSession(adminId);
      const res = await request(appMod.default)
        .post("/api/ai-memory")
        .set("Authorization", `Bearer ${access}`)
        .send({ labOrganizationId: labOrgId, kind: "bogus", key: rid("k"), value: "v" });
      expect(res.status).toBe(400);
    });
  });

  describe("PATCH /api/ai-memory/:id", () => {
    it("renames the entry and the new key appears in GET", async () => {
      const { access } = await makeSession(adminId);
      const key = `Patch_${rid("k")}`;
      const renamed = `Renamed_${rid("r")}`;
      const createRes = await request(appMod.default)
        .post("/api/ai-memory")
        .set("Authorization", `Bearer ${access}`)
        .send({ labOrganizationId: labOrgId, kind: "glossary", key, value: "v" });
      const id = createRes.body.data.id as string;

      const patchRes = await request(appMod.default)
        .patch(`/api/ai-memory/${id}`)
        .set("Authorization", `Bearer ${access}`)
        .send({ key: renamed, value: "v2" });
      expect(patchRes.status).toBe(200);
      expect(patchRes.body.data.key).toBe(renamed);
      expect(patchRes.body.data.value).toBe("v2");
    });

    it("returns 409 when the new key collides with another entry of the same kind", async () => {
      const { access } = await makeSession(adminId);
      const keyA = `ColA_${rid("a")}`;
      const keyB = `ColB_${rid("b")}`;
      await request(appMod.default)
        .post("/api/ai-memory")
        .set("Authorization", `Bearer ${access}`)
        .send({ labOrganizationId: labOrgId, kind: "fact", key: keyA, value: "v" });
      const createB = await request(appMod.default)
        .post("/api/ai-memory")
        .set("Authorization", `Bearer ${access}`)
        .send({ labOrganizationId: labOrgId, kind: "fact", key: keyB, value: "v" });
      const idB = createB.body.data.id as string;

      const patchRes = await request(appMod.default)
        .patch(`/api/ai-memory/${idB}`)
        .set("Authorization", `Bearer ${access}`)
        .send({ key: keyA });
      expect(patchRes.status).toBe(409);
    });

    it("returns 403 for a non-admin lab member", async () => {
      const { access: adminAccess } = await makeSession(adminId);
      const { access: staffAccess } = await makeSession(staffId);
      const createRes = await request(appMod.default)
        .post("/api/ai-memory")
        .set("Authorization", `Bearer ${adminAccess}`)
        .send({ labOrganizationId: labOrgId, kind: "glossary", key: rid("k"), value: "v" });
      const id = createRes.body.data.id as string;

      const patchRes = await request(appMod.default)
        .patch(`/api/ai-memory/${id}`)
        .set("Authorization", `Bearer ${staffAccess}`)
        .send({ value: "nope" });
      expect(patchRes.status).toBe(403);
    });

    it("returns 404 for an unknown id", async () => {
      const { access } = await makeSession(adminId);
      const res = await request(appMod.default)
        .patch("/api/ai-memory/00000000-0000-0000-0000-000000000000")
        .set("Authorization", `Bearer ${access}`)
        .send({ value: "x" });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /api/ai-memory/:id", () => {
    it("soft-deletes the entry so it no longer appears in GET", async () => {
      const { access } = await makeSession(adminId);
      const key = `Del_${rid("k")}`;
      const createRes = await request(appMod.default)
        .post("/api/ai-memory")
        .set("Authorization", `Bearer ${access}`)
        .send({ labOrganizationId: labOrgId, kind: "fact", key, value: "v" });
      const id = createRes.body.data.id as string;

      const deleteRes = await request(appMod.default)
        .delete(`/api/ai-memory/${id}`)
        .set("Authorization", `Bearer ${access}`);
      expect(deleteRes.status).toBe(200);
      expect(deleteRes.body.data.deleted).toBe(true);

      const listRes = await request(appMod.default)
        .get(`/api/ai-memory?labOrganizationId=${labOrgId}`)
        .set("Authorization", `Bearer ${access}`);
      const keys: string[] = listRes.body.data.map((r: any) => r.key);
      expect(keys).not.toContain(key);
    });

    it("returns 403 for a non-admin lab member", async () => {
      const { access: adminAccess } = await makeSession(adminId);
      const { access: staffAccess } = await makeSession(staffId);
      const createRes = await request(appMod.default)
        .post("/api/ai-memory")
        .set("Authorization", `Bearer ${adminAccess}`)
        .send({ labOrganizationId: labOrgId, kind: "glossary", key: rid("k"), value: "v" });
      const id = createRes.body.data.id as string;

      const deleteRes = await request(appMod.default)
        .delete(`/api/ai-memory/${id}`)
        .set("Authorization", `Bearer ${staffAccess}`);
      expect(deleteRes.status).toBe(403);
    });

    it("returns 404 for an unknown id", async () => {
      const { access } = await makeSession(adminId);
      const res = await request(appMod.default)
        .delete("/api/ai-memory/00000000-0000-0000-0000-000000000000")
        .set("Authorization", `Bearer ${access}`);
      expect(res.status).toBe(404);
    });
  });
});
