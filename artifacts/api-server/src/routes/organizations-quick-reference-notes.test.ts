/**
 * Integration tests for the Quick Reference Notes routes (regression guard).
 *
 * Quick Reference Notes shipped with no test coverage at all, and every one
 * of its six routes called `requireAnyRole(req as any, organizationId, roles)`
 * — passing the whole Express request object instead of a user id string.
 * That object reached the pg driver as a bound query parameter, which threw
 * ("Converting circular structure to JSON") deep inside `pg` while poisoning
 * the pooled connection, so the *next* request to reuse that connection also
 * failed — observed in production as a valid `/api/auth/me` call returning a
 * spurious 401 immediately after any Quick Reference Notes call.
 *
 * Skipped when DATABASE_URL is not configured. All inserted rows are removed
 * in afterAll so the suite is safe to run against a shared dev DB.
 *
 * Coverage:
 *  - GET    /:organizationId/quick-reference-notes               (list)
 *  - POST   /:organizationId/quick-reference-notes                (create)
 *  - POST   /:organizationId/quick-reference-notes/seed-defaults  (seed)
 *  - PATCH  /:organizationId/quick-reference-notes/:noteId        (update)
 *  - DELETE /:organizationId/quick-reference-notes/:noteId        (soft-delete)
 *  - PATCH  /:organizationId/quick-reference-notes/:noteId/order  (reorder)
 *  - Permission matrix: owner/admin/user can write; billing/read_only can
 *    only read; non-members get nothing; unauthenticated gets 401.
 *  - Regression: none of the six endpoints leaves the pooled connection in a
 *    state that breaks the very next request.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import request from "supertest";
import * as path from "node:path";
import { vi } from "vitest";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(require("os").tmpdir(), "labtrax-test-media-qrn"),
  extractMediaFileName: () => null,
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

/**
 * Phase 3 lab creation requires license number, phone, billing email, and a
 * street address in addition to a unique name. Helper builds a complete,
 * valid lab payload so setup is not rejected by field validation.
 */
function labBody(name: string) {
  return {
    type: "lab" as const,
    name,
    licenseNumber: `LIC-${randomBytes(3).toString("hex")}`,
    phone: "555-111-2222",
    billingEmail: "lab@example.com",
    addressLine1: "123 Test St",
  };
}

maybe("Quick Reference Notes routes (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let authLib: typeof import("../lib/auth.js");

  const ownerId = rid("u"); // owner of the main lab — a write role
  const adminId = rid("u"); // admin membership — a write role
  const staffUserId = rid("u"); // role "user" membership — a write role
  const billingId = rid("u"); // role "billing" membership — read-only
  const readOnlyId = rid("u"); // role "read_only" membership — read-only
  const providerAdminId = rid("u"); // provider admin — may manage provider templates
  const providerUserId = rid("u"); // provider user — may read but not manage
  const outsiderId = rid("u"); // authenticated, but NO membership at all

  const createdUserIds = [
    ownerId,
    adminId,
    staffUserId,
    billingId,
    readOnlyId,
    providerAdminId,
    providerUserId,
    outsiderId,
  ];
  const createdOrgIds: string[] = [];
  const sessions: Record<string, string> = {};

  let labId: string;
  let providerId: string;
  let emptyLabId: string; // dedicated, kept empty for the seed-defaults pair

  async function makeSession(userId: string): Promise<string> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const refresh = authLib.signRefreshToken(userId, sessionId);
    const hash = createHash("sha256").update(refresh).digest("hex");
    await db.insert(userSessions).values({ id: sessionId, userId, tokenHash: hash, expiresAt });
    return authLib.signAccessToken(userId, sessionId);
  }

  async function insertNote(
    overrides: Partial<{
      organizationId: string;
      body: string;
      label: string | null;
      isActive: boolean;
      displayOrder: number;
    }> = {},
  ) {
    const { db, quickReferenceNotes } = dbMod as any;
    const [row] = await db
      .insert(quickReferenceNotes)
      .values({
        organizationId: labId,
        body: "Seed body",
        displayOrder: 0,
        ...overrides,
      })
      .returning();
    return row;
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] = process.env["JWT_SECRET"] ?? "labtrax-test-secret-qrn";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    authLib = await import("../lib/auth.js");

    const { db, users, organizationMemberships } = dbMod as any;
    for (const id of createdUserIds) {
      await db.insert(users).values({ id, username: `qrn_${id}`, password: "doesnotmatter" });
    }

    sessions[ownerId] = await makeSession(ownerId);

    // Main lab: owner is created through the real API so we don't have to
    // hand-roll what "creating a lab" means; the owner membership it produces
    // is exactly what production users have.
    const createLab = await request(appMod.default)
      .post("/api/organizations")
      .set("Authorization", `Bearer ${sessions[ownerId]}`)
      .send(labBody(rid("QrnLab")));
    if (createLab.status !== 201) {
      throw new Error(
        `Setup failed creating main lab: ${createLab.status} ${JSON.stringify(createLab.body)}`,
      );
    }
    labId = createLab.body.data.id;
    createdOrgIds.push(labId);

    await db.insert(organizationMemberships).values([
      { labId, userId: adminId, role: "admin", status: "active" },
      { labId, userId: staffUserId, role: "user", status: "active" },
      { labId, userId: billingId, role: "billing", status: "active" },
      { labId, userId: readOnlyId, role: "read_only", status: "active" },
      // outsiderId is intentionally left with no membership row on this lab.
    ]);

    providerId = rid("QrnProvider");
    createdOrgIds.push(providerId);
    await db.insert((dbMod as any).organizations).values({
      id: providerId,
      type: "provider",
      name: "Quick Reference Provider",
      parentLabOrganizationId: labId,
    });
    await db.insert(organizationMemberships).values([
      { labId: providerId, userId: providerAdminId, role: "admin", status: "active" },
      { labId: providerId, userId: providerUserId, role: "user", status: "active" },
    ]);
    // Dedicated, kept-empty lab so "seeds when empty" isn't order-coupled to
    // whatever the create/update/delete tests have already inserted.
    const createEmptyLab = await request(appMod.default)
      .post("/api/organizations")
      .set("Authorization", `Bearer ${sessions[ownerId]}`)
      .send(labBody(rid("QrnSeedLab")));
    if (createEmptyLab.status !== 201) {
      throw new Error(
        `Setup failed creating seed lab: ${createEmptyLab.status} ${JSON.stringify(createEmptyLab.body)}`,
      );
    }
    emptyLabId = createEmptyLab.body.data.id;
    createdOrgIds.push(emptyLabId);
  });

  beforeEach(async () => {
    if (!SHOULD_RUN) return;
    for (const id of [
      ownerId,
      adminId,
      staffUserId,
      billingId,
      readOnlyId,
      outsiderId,
      providerAdminId,
      providerUserId,
    ]) {
      sessions[id] = await makeSession(id);
    }
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const { db, quickReferenceNotes, organizationMemberships, organizations, userSessions, users } =
      dbMod as any;
    if (createdOrgIds.length) {
      await db.delete(quickReferenceNotes).where(inArray(quickReferenceNotes.organizationId, createdOrgIds));
      await db.delete(organizationMemberships).where(inArray(organizationMemberships.labId, createdOrgIds));
      await db.delete(organizations).where(inArray(organizations.id, createdOrgIds));
    }
    await db.delete(userSessions).where(inArray(userSessions.userId, createdUserIds));
    await db.delete(organizationMemberships).where(inArray(organizationMemberships.userId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
  });

  // ── GET (list) ─────────────────────────────────────────────────────────
  describe("GET /:organizationId/quick-reference-notes", () => {
    it("returns 401 when unauthenticated", async () => {
      const r = await request(appMod.default).get(`/api/organizations/${labId}/quick-reference-notes`);
      expect(r.status).toBe(401);
    });

    it("returns 403 for an authenticated user with no membership in the lab", async () => {
      const r = await request(appMod.default)
        .get(`/api/organizations/${labId}/quick-reference-notes`)
        .set("Authorization", `Bearer ${sessions[outsiderId]}`);
      expect(r.status).toBe(403);
    });

    it.each([
      ["owner", () => ownerId],
      ["admin", () => adminId],
      ["user", () => staffUserId],
      ["billing", () => billingId],
      ["read_only", () => readOnlyId],
    ])("allows role %s to list — reading is permissive for any active member", async (_role, getId) => {
      const r = await request(appMod.default)
        .get(`/api/organizations/${labId}/quick-reference-notes`)
        .set("Authorization", `Bearer ${sessions[getId()]}`);
      expect(r.status).toBe(200);
      expect(Array.isArray(r.body.data.notes)).toBe(true);
    });

    it("includes a directly-inserted note in the list", async () => {
      const note = await insertNote({ body: "List-visible note", label: "List test" });
      const r = await request(appMod.default)
        .get(`/api/organizations/${labId}/quick-reference-notes`)
        .set("Authorization", `Bearer ${sessions[ownerId]}`);
      expect(r.status).toBe(200);
      expect(r.body.data.notes.some((n: any) => n.id === note.id)).toBe(true);
    });
  });

  // ── POST (create) ──────────────────────────────────────────────────────
  describe("POST /:organizationId/quick-reference-notes", () => {
    it("returns 401 when unauthenticated", async () => {
      const r = await request(appMod.default)
        .post(`/api/organizations/${labId}/quick-reference-notes`)
        .send({ body: "Nope" });
      expect(r.status).toBe(401);
    });

    it("returns 403 for a billing role", async () => {
      const r = await request(appMod.default)
        .post(`/api/organizations/${labId}/quick-reference-notes`)
        .set("Authorization", `Bearer ${sessions[billingId]}`)
        .send({ body: "Should not be created" });
      expect(r.status).toBe(403);
    });

    it("returns 403 for a read_only role", async () => {
      const r = await request(appMod.default)
        .post(`/api/organizations/${labId}/quick-reference-notes`)
        .set("Authorization", `Bearer ${sessions[readOnlyId]}`)
        .send({ body: "Should not be created" });
      expect(r.status).toBe(403);
    });

    it("returns 403 for a non-member entirely", async () => {
      const r = await request(appMod.default)
        .post(`/api/organizations/${labId}/quick-reference-notes`)
        .set("Authorization", `Bearer ${sessions[outsiderId]}`)
        .send({ body: "Should not be created" });
      expect(r.status).toBe(403);
    });

    it("returns 400 when body is missing", async () => {
      const r = await request(appMod.default)
        .post(`/api/organizations/${labId}/quick-reference-notes`)
        .set("Authorization", `Bearer ${sessions[ownerId]}`)
        .send({ label: "No body" });
      expect(r.status).toBe(400);
    });

    it("returns 400 when body is an empty string", async () => {
      const r = await request(appMod.default)
        .post(`/api/organizations/${labId}/quick-reference-notes`)
        .set("Authorization", `Bearer ${sessions[ownerId]}`)
        .send({ body: "" });
      expect(r.status).toBe(400);
    });

    it.each([
      ["owner", () => ownerId],
      ["admin", () => adminId],
      ["user", () => staffUserId],
    ])("allows write role %s to create a template", async (role, getId) => {
      const r = await request(appMod.default)
        .post(`/api/organizations/${labId}/quick-reference-notes`)
        .set("Authorization", `Bearer ${sessions[getId()]}`)
        .send({ body: `Courtesy text sent (${role})`, label: "Courtesy Text Sent" });
      expect(r.status).toBe(200);
      expect(r.body.data.note).toMatchObject({
        organizationId: labId,
        body: `Courtesy text sent (${role})`,
        label: "Courtesy Text Sent",
        isActive: true,
      });
    });

    it("defaults label to null and isActive to true when omitted", async () => {
      const r = await request(appMod.default)
        .post(`/api/organizations/${labId}/quick-reference-notes`)
        .set("Authorization", `Bearer ${sessions[ownerId]}`)
        .send({ body: "No label supplied" });
      expect(r.status).toBe(200);
      expect(r.body.data.note.label).toBeNull();
      expect(r.body.data.note.isActive).toBe(true);
    });
  });

  describe("provider template library", () => {
    it("lets provider members read their provider library", async () => {
      const response = await request(appMod.default)
        .get(`/api/organizations/${providerId}/quick-reference-notes`)
        .set("Authorization", `Bearer ${sessions[providerUserId]}`);
      expect(response.status).toBe(200);
      expect(response.body.data.notes).toEqual([]);
    });

    it("allows only provider admins to create provider templates", async () => {
      const denied = await request(appMod.default)
        .post(`/api/organizations/${providerId}/quick-reference-notes`)
        .set("Authorization", `Bearer ${sessions[providerUserId]}`)
        .send({ body: "Please call before delivery." });
      expect(denied.status).toBe(403);

      const created = await request(appMod.default)
        .post(`/api/organizations/${providerId}/quick-reference-notes`)
        .set("Authorization", `Bearer ${sessions[providerAdminId]}`)
        .send({ body: "Please call before delivery.", label: "Call ahead" });
      expect(created.status).toBe(200);
      expect(created.body.data.note.organizationId).toBe(providerId);
    });
  });

  // ── POST seed-defaults ─────────────────────────────────────────────────
  describe("POST /:organizationId/quick-reference-notes/seed-defaults", () => {
    it("returns 401 when unauthenticated", async () => {
      const r = await request(appMod.default).post(
        `/api/organizations/${labId}/quick-reference-notes/seed-defaults`,
      );
      expect(r.status).toBe(401);
    });

    it("returns 403 for a read_only member (insufficient role)", async () => {
      const r = await request(appMod.default)
        .post(`/api/organizations/${labId}/quick-reference-notes/seed-defaults`)
        .set("Authorization", `Bearer ${sessions[readOnlyId]}`);
      expect(r.status).toBe(403);
    });

    it("returns 403 for a non-member", async () => {
      const r = await request(appMod.default)
        .post(`/api/organizations/${labId}/quick-reference-notes/seed-defaults`)
        .set("Authorization", `Bearer ${sessions[outsiderId]}`);
      expect(r.status).toBe(403);
    });

    it("seeds default templates into an empty lab, and does not duplicate on a second call", async () => {
      const first = await request(appMod.default)
        .post(`/api/organizations/${emptyLabId}/quick-reference-notes/seed-defaults`)
        .set("Authorization", `Bearer ${sessions[ownerId]}`);
      expect(first.status).toBe(200);
      expect(first.body.data.seeded).toBe(true);
      expect(Array.isArray(first.body.data.notes)).toBe(true);
      expect(first.body.data.notes.length).toBeGreaterThan(0);
      const seededCount = first.body.data.notes.length;

      const second = await request(appMod.default)
        .post(`/api/organizations/${emptyLabId}/quick-reference-notes/seed-defaults`)
        .set("Authorization", `Bearer ${sessions[ownerId]}`);
      expect(second.status).toBe(200);
      expect(second.body.data.seeded).toBe(false);

      // Confirm the second call truly inserted nothing further.
      const { db, quickReferenceNotes } = dbMod as any;
      const rows = await db
        .select()
        .from(quickReferenceNotes)
        .where(eq(quickReferenceNotes.organizationId, emptyLabId));
      expect(rows.length).toBe(seededCount);
    });
  });

  // ── PATCH (update) ─────────────────────────────────────────────────────
  describe("PATCH /:organizationId/quick-reference-notes/:noteId", () => {
    it("returns 401 when unauthenticated", async () => {
      const note = await insertNote();
      const r = await request(appMod.default)
        .patch(`/api/organizations/${labId}/quick-reference-notes/${note.id}`)
        .send({ body: "Updated" });
      expect(r.status).toBe(401);
    });

    it("returns 403 for a non-write role", async () => {
      const note = await insertNote();
      const r = await request(appMod.default)
        .patch(`/api/organizations/${labId}/quick-reference-notes/${note.id}`)
        .set("Authorization", `Bearer ${sessions[billingId]}`)
        .send({ body: "Updated" });
      expect(r.status).toBe(403);
    });

    it("returns 404 for a note id that does not exist", async () => {
      const r = await request(appMod.default)
        .patch(`/api/organizations/${labId}/quick-reference-notes/${rid("missing")}`)
        .set("Authorization", `Bearer ${sessions[ownerId]}`)
        .send({ body: "Updated" });
      expect(r.status).toBe(404);
    });

    it("returns 400 when body is set to an empty string", async () => {
      const note = await insertNote();
      const r = await request(appMod.default)
        .patch(`/api/organizations/${labId}/quick-reference-notes/${note.id}`)
        .set("Authorization", `Bearer ${sessions[ownerId]}`)
        .send({ body: "" });
      expect(r.status).toBe(400);
    });

    it("updates body and label for a write role", async () => {
      const note = await insertNote({ body: "Original", label: "Old label" });
      const r = await request(appMod.default)
        .patch(`/api/organizations/${labId}/quick-reference-notes/${note.id}`)
        .set("Authorization", `Bearer ${sessions[adminId]}`)
        .send({ body: "Updated body", label: "New label" });
      expect(r.status).toBe(200);
      expect(r.body.data.note).toMatchObject({ id: note.id, body: "Updated body", label: "New label" });
    });

    it("toggles isActive (used by Hide/Restore)", async () => {
      const note = await insertNote({ isActive: true });
      const r = await request(appMod.default)
        .patch(`/api/organizations/${labId}/quick-reference-notes/${note.id}`)
        .set("Authorization", `Bearer ${sessions[staffUserId]}`)
        .send({ isActive: false });
      expect(r.status).toBe(200);
      expect(r.body.data.note.isActive).toBe(false);
    });
  });

  // ── DELETE (soft-delete) ───────────────────────────────────────────────
  describe("DELETE /:organizationId/quick-reference-notes/:noteId", () => {
    it("returns 401 when unauthenticated", async () => {
      const note = await insertNote();
      const r = await request(appMod.default).delete(
        `/api/organizations/${labId}/quick-reference-notes/${note.id}`,
      );
      expect(r.status).toBe(401);
    });

    it("returns 403 for a non-write role", async () => {
      const note = await insertNote();
      const r = await request(appMod.default)
        .delete(`/api/organizations/${labId}/quick-reference-notes/${note.id}`)
        .set("Authorization", `Bearer ${sessions[readOnlyId]}`);
      expect(r.status).toBe(403);
    });

    it("returns 404 for a note id that does not exist", async () => {
      const r = await request(appMod.default)
        .delete(`/api/organizations/${labId}/quick-reference-notes/${rid("missing")}`)
        .set("Authorization", `Bearer ${sessions[ownerId]}`);
      expect(r.status).toBe(404);
    });

    it("soft-deletes for a write role (isActive=false), and the note remains visible in the list", async () => {
      const note = await insertNote({ isActive: true });
      const r = await request(appMod.default)
        .delete(`/api/organizations/${labId}/quick-reference-notes/${note.id}`)
        .set("Authorization", `Bearer ${sessions[ownerId]}`);
      expect(r.status).toBe(200);
      expect(r.body.data.deleted).toBe(true);
      expect(r.body.data.note.isActive).toBe(false);

      const list = await request(appMod.default)
        .get(`/api/organizations/${labId}/quick-reference-notes`)
        .set("Authorization", `Bearer ${sessions[ownerId]}`);
      const found = list.body.data.notes.find((n: any) => n.id === note.id);
      expect(found).toBeDefined();
      expect(found.isActive).toBe(false);
    });
  });

  // ── PATCH order (reorder) ──────────────────────────────────────────────
  describe("PATCH /:organizationId/quick-reference-notes/:noteId/order", () => {
    it("returns 401 when unauthenticated", async () => {
      const note = await insertNote();
      const r = await request(appMod.default)
        .patch(`/api/organizations/${labId}/quick-reference-notes/${note.id}/order`)
        .send({ displayOrder: 5 });
      expect(r.status).toBe(401);
    });

    it("returns 403 for a non-write role", async () => {
      const note = await insertNote();
      const r = await request(appMod.default)
        .patch(`/api/organizations/${labId}/quick-reference-notes/${note.id}/order`)
        .set("Authorization", `Bearer ${sessions[billingId]}`)
        .send({ displayOrder: 5 });
      expect(r.status).toBe(403);
    });

    it("returns 404 for a note id that does not exist", async () => {
      const r = await request(appMod.default)
        .patch(`/api/organizations/${labId}/quick-reference-notes/${rid("missing")}/order`)
        .set("Authorization", `Bearer ${sessions[ownerId]}`)
        .send({ displayOrder: 5 });
      expect(r.status).toBe(404);
    });

    it("returns 400 when displayOrder is missing", async () => {
      const note = await insertNote();
      const r = await request(appMod.default)
        .patch(`/api/organizations/${labId}/quick-reference-notes/${note.id}/order`)
        .set("Authorization", `Bearer ${sessions[ownerId]}`)
        .send({});
      expect(r.status).toBe(400);
    });

    it("updates displayOrder for a write role", async () => {
      const note = await insertNote({ displayOrder: 0 });
      const r = await request(appMod.default)
        .patch(`/api/organizations/${labId}/quick-reference-notes/${note.id}/order`)
        .set("Authorization", `Bearer ${sessions[ownerId]}`)
        .send({ displayOrder: 7 });
      expect(r.status).toBe(200);
      expect(r.body.data.note.displayOrder).toBe(7);
    });
  });

  // ── Connection-poisoning regression ────────────────────────────────────
  describe("connection-poisoning regression", () => {
    it("every QRN endpoint leaves the pooled connection healthy for the very next request", async () => {
      const createRegLab = await request(appMod.default)
        .post("/api/organizations")
        .set("Authorization", `Bearer ${sessions[ownerId]}`)
        .send(labBody(rid("QrnRegressionLab")));
      expect(createRegLab.status).toBe(201);
      const regLabId = createRegLab.body.data.id;
      createdOrgIds.push(regLabId);

      const note = await insertNote({ organizationId: regLabId, body: "Regression note", displayOrder: 0 });

      const calls: Array<() => Promise<{ status: number }>> = [
        () =>
          request(appMod.default)
            .get(`/api/organizations/${regLabId}/quick-reference-notes`)
            .set("Authorization", `Bearer ${sessions[ownerId]}`),
        () =>
          request(appMod.default)
            .post(`/api/organizations/${regLabId}/quick-reference-notes`)
            .set("Authorization", `Bearer ${sessions[ownerId]}`)
            .send({ body: "Poison check create" }),
        () =>
          request(appMod.default)
            .patch(`/api/organizations/${regLabId}/quick-reference-notes/${note.id}`)
            .set("Authorization", `Bearer ${sessions[ownerId]}`)
            .send({ label: "Poison check update" }),
        () =>
          request(appMod.default)
            .patch(`/api/organizations/${regLabId}/quick-reference-notes/${note.id}/order`)
            .set("Authorization", `Bearer ${sessions[ownerId]}`)
            .send({ displayOrder: 3 }),
        () =>
          request(appMod.default)
            .delete(`/api/organizations/${regLabId}/quick-reference-notes/${note.id}`)
            .set("Authorization", `Bearer ${sessions[ownerId]}`),
        () =>
          request(appMod.default)
            .post(`/api/organizations/${regLabId}/quick-reference-notes/seed-defaults`)
            .set("Authorization", `Bearer ${sessions[ownerId]}`),
        // A permission *rejection* (403) is also a request the router handles
        // for these routes — confirm it does not poison the pool either.
        () =>
          request(appMod.default)
            .post(`/api/organizations/${regLabId}/quick-reference-notes`)
            .set("Authorization", `Bearer ${sessions[outsiderId]}`)
            .send({ body: "Should 403" }),
      ];

      for (const call of calls) {
        const qrnRes = await call();
        // Never a driver crash, and specifically never the poisoned-connection
        // symptom (401) on a call that is otherwise perfectly authenticated.
        expect(qrnRes.status).toBeLessThan(500);
        expect(qrnRes.status).not.toBe(401);

        // The exact symptom reported in production: a valid, unrelated
        // /api/auth/me call failing right after a Quick Reference Notes call.
        const me = await request(appMod.default)
          .get("/api/auth/me")
          .set("Authorization", `Bearer ${sessions[ownerId]}`);
        expect(me.status).toBe(200);
      }
    });
  });
});
