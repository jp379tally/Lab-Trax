/**
 * Integration tests for GET/POST/PATCH/DELETE /api/locations (regression guard).
 *
 * Skipped when DATABASE_URL is not configured. All inserted rows are removed
 * in afterAll so the suite is safe to run against a shared dev DB.
 *
 * Coverage:
 *  - GET /api/locations — seeds 14 built-in stations on first request for a new org
 *  - GET /api/locations?activeOnly=true — returns only active locations
 *  - POST /api/locations — creates a location (201)
 *  - PATCH /api/locations/:id — updates name, code, isActive, sortOrder
 *  - DELETE /api/locations/:id — removes a location
 *  - POST /api/locations — duplicate code within same org returns a non-2xx error
 *  - POST /api/locations — non-admin org member returns 403
 *  - GET /api/locations — non-member of the org returns 403
 *  - Unauthenticated requests return 401
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { inArray, eq } from "drizzle-orm";
import request from "supertest";
import * as path from "node:path";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(require("os").tmpdir(), "labtrax-test-media-locations"),
  extractMediaFileName: () => null,
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

const BUILT_IN_STATION_COUNT = 14;

maybe("Locations (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let authLib: typeof import("../lib/auth.js");

  const adminId = rid("u");
  const nonAdminId = rid("na");
  const labOrgId = rid("lab");

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
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-locations";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    authLib = await import("../lib/auth.js");

    const { db, users, organizations, organizationMemberships } = dbMod as any;

    await db.insert(users).values([
      { id: adminId, username: `locadmin_${adminId}`, password: "x" },
      { id: nonAdminId, username: `locmem_${nonAdminId}`, password: "x" },
    ]);

    await db.insert(organizations).values({
      id: labOrgId,
      type: "lab",
      name: rid("LocationsTestLab"),
    });

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
      labLocations,
      userSessions,
      organizationMemberships,
      organizations,
      users,
    } = dbMod as any;

    await db.delete(labLocations).where(eq(labLocations.labOrganizationId, labOrgId));
    await db.delete(userSessions).where(inArray(userSessions.userId, [adminId, nonAdminId]));
    await db.delete(organizationMemberships).where(
      inArray(organizationMemberships.userId, [adminId, nonAdminId]),
    );
    await db.delete(organizations).where(eq(organizations.id, labOrgId));
    await db.delete(users).where(inArray(users.id, [adminId, nonAdminId]));
  });

  // ── GET — seed on first request ───────────────────────────────────────────

  it("GET /api/locations seeds 14 built-in stations on first request", async () => {
    const { access } = await makeSession(adminId);

    const r = await request(appMod.default)
      .get(`/api/locations?organizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${access}`);

    expect(r.status).toBe(200);
    const rows: any[] = r.body.data ?? [];
    expect(rows.length).toBe(BUILT_IN_STATION_COUNT);
    const codes = rows.map((row: any) => row.code);
    expect(codes).toContain("received");
    expect(codes).toContain("complete");
    expect(codes).toContain("shipped");
  });

  it("GET /api/locations is idempotent — second call does not duplicate rows", async () => {
    const { access } = await makeSession(adminId);

    const r = await request(appMod.default)
      .get(`/api/locations?organizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${access}`);

    expect(r.status).toBe(200);
    // Should still be exactly 14 — no duplicate seeding
    const rows: any[] = r.body.data ?? [];
    expect(rows.length).toBe(BUILT_IN_STATION_COUNT);
  });

  it("GET /api/locations?activeOnly=true returns only active locations", async () => {
    const { db, labLocations } = dbMod as any;
    const { access } = await makeSession(adminId);

    // Deactivate one location via PATCH first (we need the id from a seeded row)
    const listR = await request(appMod.default)
      .get(`/api/locations?organizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${access}`);
    expect(listR.status).toBe(200);
    const firstId: string = listR.body.data[0].id;

    const patchR = await request(appMod.default)
      .patch(`/api/locations/${firstId}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ isActive: false });
    expect(patchR.status).toBe(200);

    try {
      const r = await request(appMod.default)
        .get(`/api/locations?organizationId=${labOrgId}&activeOnly=true`)
        .set("Authorization", `Bearer ${access}`);

      expect(r.status).toBe(200);
      const rows: any[] = r.body.data ?? [];
      expect(rows.every((row: any) => row.isActive === true)).toBe(true);
      const ids = rows.map((row: any) => row.id);
      expect(ids).not.toContain(firstId);
    } finally {
      // Restore the row for subsequent tests
      await db
        .update(labLocations)
        .set({ isActive: true })
        .where(eq(labLocations.id, firstId));
    }
  });

  // ── POST — create ─────────────────────────────────────────────────────────

  it("POST /api/locations creates a new location and returns 201", async () => {
    const { access } = await makeSession(adminId);
    const name = rid("Custom Station");
    const code = rid("custom_code");

    const r = await request(appMod.default)
      .post("/api/locations")
      .set("Authorization", `Bearer ${access}`)
      .send({ organizationId: labOrgId, name, code, isActive: true, sortOrder: 99 });

    expect(r.status).toBe(201);
    expect(r.body.data).toBeDefined();
    expect(r.body.data.name).toBe(name);
    expect(r.body.data.code).toBe(code);
    expect(r.body.data.labOrganizationId).toBe(labOrgId);
    expect(r.body.data.isActive).toBe(true);
    expect(r.body.data.sortOrder).toBe(99);
  });

  it("POST /api/locations — missing required fields returns 400", async () => {
    const { access } = await makeSession(adminId);

    const r = await request(appMod.default)
      .post("/api/locations")
      .set("Authorization", `Bearer ${access}`)
      // missing `code`
      .send({ organizationId: labOrgId, name: "No Code Station" });

    expect(r.status).toBe(400);
  });

  // ── POST — duplicate code conflict ────────────────────────────────────────

  it("POST /api/locations — duplicate code in same org is rejected", async () => {
    const { access } = await makeSession(adminId);
    const code = rid("dup_code");

    const first = await request(appMod.default)
      .post("/api/locations")
      .set("Authorization", `Bearer ${access}`)
      .send({ organizationId: labOrgId, name: "First Station", code });
    expect(first.status).toBe(201);

    // Second insert with the same (organizationId, code) pair must fail
    const second = await request(appMod.default)
      .post("/api/locations")
      .set("Authorization", `Bearer ${access}`)
      .send({ organizationId: labOrgId, name: "Duplicate Station", code });
    expect(second.status).toBeGreaterThanOrEqual(400);
  });

  // ── PATCH — update ────────────────────────────────────────────────────────

  it("PATCH /api/locations/:id updates the location and returns 200", async () => {
    const { access } = await makeSession(adminId);
    const code = rid("patch_code");
    const updatedName = rid("Updated Name");

    const create = await request(appMod.default)
      .post("/api/locations")
      .set("Authorization", `Bearer ${access}`)
      .send({ organizationId: labOrgId, name: rid("Before Patch"), code });
    expect(create.status).toBe(201);
    const id: string = create.body.data.id;

    const r = await request(appMod.default)
      .patch(`/api/locations/${id}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ name: updatedName, isActive: false, sortOrder: 50 });

    expect(r.status).toBe(200);
    expect(r.body.data.id).toBe(id);
    expect(r.body.data.name).toBe(updatedName);
    expect(r.body.data.isActive).toBe(false);
    expect(r.body.data.sortOrder).toBe(50);
  });

  it("PATCH /api/locations/:id — non-existent id returns 404", async () => {
    const { access } = await makeSession(adminId);

    const r = await request(appMod.default)
      .patch("/api/locations/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${access}`)
      .send({ name: "Ghost" });

    expect(r.status).toBe(404);
  });

  // ── DELETE ────────────────────────────────────────────────────────────────

  it("DELETE /api/locations/:id removes the location and returns 200", async () => {
    const { access } = await makeSession(adminId);
    const code = rid("del_code");

    const create = await request(appMod.default)
      .post("/api/locations")
      .set("Authorization", `Bearer ${access}`)
      .send({ organizationId: labOrgId, name: rid("To Delete"), code });
    expect(create.status).toBe(201);
    const id: string = create.body.data.id;

    const del = await request(appMod.default)
      .delete(`/api/locations/${id}`)
      .set("Authorization", `Bearer ${access}`);

    expect(del.status).toBe(200);
    expect(del.body.data.deleted).toBe(true);

    // Verify it is gone from list
    const list = await request(appMod.default)
      .get(`/api/locations?organizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${access}`);
    expect(list.status).toBe(200);
    const ids: string[] = (list.body.data ?? []).map((row: any) => row.id);
    expect(ids).not.toContain(id);
  });

  it("DELETE /api/locations/:id — non-existent id returns 404", async () => {
    const { access } = await makeSession(adminId);

    const r = await request(appMod.default)
      .delete("/api/locations/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${access}`);

    expect(r.status).toBe(404);
  });

  // ── RBAC — non-admin cannot write ─────────────────────────────────────────

  it("POST /api/locations — non-admin org member returns 403", async () => {
    const { access } = await makeSession(nonAdminId);

    const r = await request(appMod.default)
      .post("/api/locations")
      .set("Authorization", `Bearer ${access}`)
      .send({ organizationId: labOrgId, name: "Rejected", code: rid("na_code") });

    expect(r.status).toBe(403);
  });

  it("PATCH /api/locations/:id — non-admin org member returns 403", async () => {
    // First create a location as admin to get a valid id
    const { access: adminAccess } = await makeSession(adminId);
    const create = await request(appMod.default)
      .post("/api/locations")
      .set("Authorization", `Bearer ${adminAccess}`)
      .send({ organizationId: labOrgId, name: rid("Admin Created"), code: rid("rbac_patch") });
    expect(create.status).toBe(201);
    const id: string = create.body.data.id;

    const { access: nonAdminAccess } = await makeSession(nonAdminId);
    const r = await request(appMod.default)
      .patch(`/api/locations/${id}`)
      .set("Authorization", `Bearer ${nonAdminAccess}`)
      .send({ name: "Unauthorized Edit" });

    expect(r.status).toBe(403);
  });

  it("DELETE /api/locations/:id — non-admin org member returns 403", async () => {
    const { access: adminAccess } = await makeSession(adminId);
    const create = await request(appMod.default)
      .post("/api/locations")
      .set("Authorization", `Bearer ${adminAccess}`)
      .send({ organizationId: labOrgId, name: rid("Admin Created"), code: rid("rbac_del") });
    expect(create.status).toBe(201);
    const id: string = create.body.data.id;

    const { access: nonAdminAccess } = await makeSession(nonAdminId);
    const r = await request(appMod.default)
      .delete(`/api/locations/${id}`)
      .set("Authorization", `Bearer ${nonAdminAccess}`);

    expect(r.status).toBe(403);
  });

  // ── RBAC — non-member cannot read ─────────────────────────────────────────

  it("GET /api/locations — non-member of the org returns 403", async () => {
    const { db, users, userSessions } = dbMod as any;
    const outsiderId = rid("out");
    await db.insert(users).values({ id: outsiderId, username: `loc_out_${outsiderId}`, password: "x" });

    try {
      const { access } = await makeSession(outsiderId);
      const r = await request(appMod.default)
        .get(`/api/locations?organizationId=${labOrgId}`)
        .set("Authorization", `Bearer ${access}`);
      expect(r.status).toBe(403);
    } finally {
      await db.delete(userSessions).where(eq(userSessions.userId, outsiderId));
      await db.delete(users).where(eq(users.id, outsiderId));
    }
  });

  // ── Auth guard ────────────────────────────────────────────────────────────

  it("unauthenticated GET /api/locations returns 401", async () => {
    const r = await request(appMod.default)
      .get(`/api/locations?organizationId=${labOrgId}`);
    expect(r.status).toBe(401);
  });

  it("unauthenticated POST /api/locations returns 401", async () => {
    const r = await request(appMod.default)
      .post("/api/locations")
      .send({ organizationId: labOrgId, name: "No Auth", code: rid("noauth") });
    expect(r.status).toBe(401);
  });

  it("unauthenticated PATCH /api/locations/:id returns 401", async () => {
    const r = await request(appMod.default)
      .patch("/api/locations/some-id")
      .send({ name: "No Auth" });
    expect(r.status).toBe(401);
  });

  it("unauthenticated DELETE /api/locations/:id returns 401", async () => {
    const r = await request(appMod.default)
      .delete("/api/locations/some-id");
    expect(r.status).toBe(401);
  });

  // ── GET — missing organizationId ──────────────────────────────────────────

  it("GET /api/locations without organizationId returns 400", async () => {
    const { access } = await makeSession(adminId);

    const r = await request(appMod.default)
      .get("/api/locations")
      .set("Authorization", `Bearer ${access}`);

    expect(r.status).toBe(400);
  });
});
