/**
 * Integration tests for owner-only /api/owner/* endpoints (regression guard).
 *
 * Skipped when DATABASE_URL is not configured. All inserted rows are removed
 * in afterAll so the suite is safe to run against a shared dev DB.
 *
 * Coverage (for each of the 7 owner endpoints):
 *  - Unauthenticated request → 401
 *  - Non-owner member (admin, billing, read_only roles) → 403
 *  - Owner member → 200 / correct response shape
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import request from "supertest";
import * as path from "node:path";
// This suite protects tenant operations after the outer Creator gate has
// passed. The separate creator-auth suite tests the exclusive identity gate.
vi.mock("../lib/creator-auth", () => ({ requireCreator: [(_req: any, _res: any, next: any) => next()] }));

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(require("os").tmpdir(), "labtrax-test-media-owner"),
  extractMediaFileName: () => null,
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("Owner-only /api/owner/* endpoints (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let authLib: typeof import("../lib/auth.js");

  const ownerUserId = rid("u");
  const nonOwnerUserId = rid("na"); // admin role — still not owner
  const billingUserId = rid("bi"); // billing role — still not owner
  const readOnlyUserId = rid("ro"); // read_only role — still not owner
  const memberUserId = rid("mb"); // user role — used as PATCH target
  const labOrgId = rid("lab");
  const labName = rid("OwnerTestLab");

  // Maps a role name to the corresponding test userId for it.each parameterization.
  const nonOwnerIds: Record<string, string> = {} as Record<string, string>;

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
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-owner";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    await (await import("./index.js")).labtraxRoutesReady;
    authLib = await import("../lib/auth.js");

    const { db, users, organizations, organizationMemberships } = dbMod as any;

    nonOwnerIds["admin"] = nonOwnerUserId;
    nonOwnerIds["billing"] = billingUserId;
    nonOwnerIds["read_only"] = readOnlyUserId;

    await db.insert(users).values([
      { id: ownerUserId, username: `ownertest_${ownerUserId}`, password: "x" },
      { id: nonOwnerUserId, username: `nonadmin_${nonOwnerUserId}`, password: "x" },
      { id: billingUserId, username: `billing_${billingUserId}`, password: "x" },
      { id: readOnlyUserId, username: `readonly_${readOnlyUserId}`, password: "x" },
      { id: memberUserId, username: `member_${memberUserId}`, password: "x" },
    ]);

    await db.insert(organizations).values({
      id: labOrgId,
      type: "lab",
      name: labName,
    });

    await db.insert(organizationMemberships).values([
      {
        id: rid("m1"),
        labId: labOrgId,
        userId: ownerUserId,
        role: "owner",
        status: "active",
        approvedByUserId: ownerUserId,
        joinedAt: new Date(),
      },
      {
        id: rid("m2"),
        labId: labOrgId,
        userId: nonOwnerUserId,
        role: "admin",
        status: "active",
        approvedByUserId: ownerUserId,
        joinedAt: new Date(),
      },
      {
        id: rid("m3"),
        labId: labOrgId,
        userId: billingUserId,
        role: "billing",
        status: "active",
        approvedByUserId: ownerUserId,
        joinedAt: new Date(),
      },
      {
        id: rid("m4"),
        labId: labOrgId,
        userId: readOnlyUserId,
        role: "read_only",
        status: "active",
        approvedByUserId: ownerUserId,
        joinedAt: new Date(),
      },
      {
        id: rid("m5"),
        labId: labOrgId,
        userId: memberUserId,
        role: "user",
        status: "active",
        approvedByUserId: ownerUserId,
        joinedAt: new Date(),
      },
    ]);
  });

  beforeEach(async () => {
    await makeSession(ownerUserId);
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const { db, auditLogs, userSessions, organizationMemberships, organizations, users } =
      dbMod as any;
    const allUserIds = [ownerUserId, nonOwnerUserId, billingUserId, readOnlyUserId, memberUserId];

    await db.delete(auditLogs).where(eq(auditLogs.organizationId, labOrgId));
    await db.delete(userSessions).where(inArray(userSessions.userId, allUserIds));
    await db.delete(organizationMemberships).where(
      eq(organizationMemberships.labId, labOrgId)
    );
    await db.delete(organizations).where(eq(organizations.id, labOrgId));
    await db.delete(users).where(inArray(users.id, allUserIds));
  });

  // ── GET /api/owner/lab-profile ─────────────────────────────────────────────

  it("GET /api/owner/lab-profile — unauthenticated returns 401", async () => {
    const r = await request(appMod.default)
      .get(`/api/owner/lab-profile?organizationId=${labOrgId}`);
    expect(r.status).toBe(401);
  });

  it.each(["admin", "billing", "read_only"])(
    "GET /api/owner/lab-profile — non-owner (%s) returns 403",
    async (role) => {
      const { access } = await makeSession(nonOwnerIds[role]);
      const r = await request(appMod.default)
        .get(`/api/owner/lab-profile?organizationId=${labOrgId}`)
        .set("Authorization", `Bearer ${access}`);
      expect(r.status).toBe(403);
    }
  );

  it("GET /api/owner/lab-profile — owner returns 200 with org fields", async () => {
    const { access } = await makeSession(ownerUserId);
    const r = await request(appMod.default)
      .get(`/api/owner/lab-profile?organizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    expect(r.body.data).toBeDefined();
    expect(r.body.data.id).toBe(labOrgId);
    expect(r.body.data.name).toBe(labName);
    expect(r.body.data).toHaveProperty("type");
  });

  // ── PATCH /api/owner/lab-profile ───────────────────────────────────────────

  it("PATCH /api/owner/lab-profile — unauthenticated returns 401", async () => {
    const r = await request(appMod.default)
      .patch("/api/owner/lab-profile")
      .send({ organizationId: labOrgId, displayName: "NewName" });
    expect(r.status).toBe(401);
  });

  it.each(["admin", "billing", "read_only"])(
    "PATCH /api/owner/lab-profile — non-owner (%s) returns 403",
    async (role) => {
      const { access } = await makeSession(nonOwnerIds[role]);
      const r = await request(appMod.default)
        .patch("/api/owner/lab-profile")
        .set("Authorization", `Bearer ${access}`)
        .send({ organizationId: labOrgId, displayName: "ShouldFail" });
      expect(r.status).toBe(403);
    }
  );

  it("PATCH /api/owner/lab-profile — owner returns 200 with updated fields", async () => {
    const { access } = await makeSession(ownerUserId);
    const displayName = rid("Display");
    const r = await request(appMod.default)
      .patch("/api/owner/lab-profile")
      .set("Authorization", `Bearer ${access}`)
      .send({ organizationId: labOrgId, displayName });
    expect(r.status).toBe(200);
    expect(r.body.data).toBeDefined();
    expect(r.body.data.id).toBe(labOrgId);
    expect(r.body.data.displayName).toBe(displayName);
  });

  // ── GET /api/owner/team ────────────────────────────────────────────────────

  it("GET /api/owner/team — unauthenticated returns 401", async () => {
    const r = await request(appMod.default)
      .get(`/api/owner/team?organizationId=${labOrgId}`);
    expect(r.status).toBe(401);
  });

  it.each(["admin", "billing", "read_only"])(
    "GET /api/owner/team — non-owner (%s) returns 403",
    async (role) => {
      const { access } = await makeSession(nonOwnerIds[role]);
      const r = await request(appMod.default)
        .get(`/api/owner/team?organizationId=${labOrgId}`)
        .set("Authorization", `Bearer ${access}`);
      expect(r.status).toBe(403);
    }
  );

  it("GET /api/owner/team — owner returns 200 with team array", async () => {
    const { access } = await makeSession(ownerUserId);
    const r = await request(appMod.default)
      .get(`/api/owner/team?organizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.data)).toBe(true);
    const userIds: string[] = r.body.data.map((m: any) => m.userId);
    expect(userIds).toContain(ownerUserId);
  });

  // ── PATCH /api/owner/team/:userId/role ─────────────────────────────────────

  it("PATCH /api/owner/team/:userId/role — unauthenticated returns 401", async () => {
    const r = await request(appMod.default)
      .patch(`/api/owner/team/${memberUserId}/role`)
      .send({ organizationId: labOrgId, role: "billing" });
    expect(r.status).toBe(401);
  });

  it.each(["admin", "billing", "read_only"])(
    "PATCH /api/owner/team/:userId/role — non-owner (%s) returns 403",
    async (role) => {
      const { access } = await makeSession(nonOwnerIds[role]);
      const r = await request(appMod.default)
        .patch(`/api/owner/team/${memberUserId}/role`)
        .set("Authorization", `Bearer ${access}`)
        .send({ organizationId: labOrgId, role: "billing" });
      expect(r.status).toBe(403);
    }
  );

  it("PATCH /api/owner/team/:userId/role — owner returns 200 with updated role", async () => {
    const { access } = await makeSession(ownerUserId);
    const r = await request(appMod.default)
      .patch(`/api/owner/team/${memberUserId}/role`)
      .set("Authorization", `Bearer ${access}`)
      .send({ organizationId: labOrgId, role: "billing" });
    expect(r.status).toBe(200);
    expect(r.body.data).toBeDefined();
    expect(r.body.data.userId).toBe(memberUserId);
    expect(r.body.data.role).toBe("billing");
  });

  it("PATCH /api/owner/team/:userId/role — writes audit log with correct fields on success", async () => {
    const { access } = await makeSession(ownerUserId);
    const { db, auditLogs } = dbMod as any;

    // memberUserId's role is "billing" after the previous test; change it to "admin"
    const r = await request(appMod.default)
      .patch(`/api/owner/team/${memberUserId}/role`)
      .set("Authorization", `Bearer ${access}`)
      .send({ organizationId: labOrgId, role: "admin" });
    expect(r.status).toBe(200);

    const auditEntry = await db.query.auditLogs.findFirst({
      where: and(
        eq(auditLogs.organizationId, labOrgId),
        eq(auditLogs.action, "owner_changed_member_role"),
        eq(auditLogs.userId, ownerUserId)
      ),
      orderBy: (t: any, { desc: d }: any) => [d(t.createdAt)],
    });

    expect(auditEntry).toBeDefined();
    expect(auditEntry?.userId).toBe(ownerUserId);
    expect(auditEntry?.metadataJson).toMatchObject({
      targetUserId: memberUserId,
      previousRole: "billing",
      newRole: "admin",
    });
  });

  it("PATCH /api/owner/team/:userId/role — demoting the sole owner returns 400", async () => {
    const { access } = await makeSession(ownerUserId);
    const r = await request(appMod.default)
      .patch(`/api/owner/team/${ownerUserId}/role`)
      .set("Authorization", `Bearer ${access}`)
      .send({ organizationId: labOrgId, role: "admin" });
    expect(r.status).toBe(400);
    expect(r.body.error ?? r.body.message ?? "").toMatch(/only owner|sole owner|transfer ownership/i);
  });

  // ── POST /api/owner/transfer-ownership ────────────────────────────────────
  // Uses an intentionally wrong confirmation phrase to confirm the auth gate
  // passes (→ 400) without permanently transferring ownership.

  it("POST /api/owner/transfer-ownership — unauthenticated returns 401", async () => {
    const r = await request(appMod.default)
      .post("/api/owner/transfer-ownership")
      .send({
        organizationId: labOrgId,
        newOwnerUserId: nonOwnerUserId,
        confirmationPhrase: "wrong phrase",
      });
    expect(r.status).toBe(401);
  });

  it.each(["admin", "billing", "read_only"])(
    "POST /api/owner/transfer-ownership — non-owner (%s) returns 403",
    async (role) => {
      const { access } = await makeSession(nonOwnerIds[role]);
      const r = await request(appMod.default)
        .post("/api/owner/transfer-ownership")
        .set("Authorization", `Bearer ${access}`)
        .send({
          organizationId: labOrgId,
          newOwnerUserId: memberUserId,
          confirmationPhrase: "wrong phrase",
        });
      expect(r.status).toBe(403);
    }
  );

  it("POST /api/owner/transfer-ownership — owner passes the auth gate (wrong phrase → 400)", async () => {
    const { access } = await makeSession(ownerUserId);
    const r = await request(appMod.default)
      .post("/api/owner/transfer-ownership")
      .set("Authorization", `Bearer ${access}`)
      .send({
        organizationId: labOrgId,
        newOwnerUserId: nonOwnerUserId,
        confirmationPhrase: "__intentionally_wrong__",
      });
    // 400 confirms the RBAC gate was cleared — a 401 or 403 would mean auth failed.
    expect(r.status).toBe(400);
  });

  // ── POST /api/owner/transfer-ownership — end-to-end happy path ───────────
  // Uses a dedicated disposable org + two members so the transfer does not
  // affect the shared ownerUserId used by all other tests.

  describe.each(["lab", "provider"] as const)("transfer-ownership for a %s organization", (orgType) => {
    const xferOwnerId = rid("xo");
    const xferTargetId = rid("xt");
    const xferOrgId = rid("xorg");
    const xferOrgName = rid("XferLab");

    beforeAll(async () => {
      const { db, users, organizations, organizationMemberships } = dbMod as any;

      await db.insert(users).values([
        { id: xferOwnerId, username: `xfer_owner_${xferOwnerId}`, password: "x", userType: orgType === "provider" ? "provider" : "lab" },
        { id: xferTargetId, username: `xfer_target_${xferTargetId}`, password: "x", userType: orgType === "provider" ? "provider" : "lab" },
      ]);

      await db.insert(organizations).values({
        id: xferOrgId,
        type: orgType,
        name: xferOrgName,
      });

      await db.insert(organizationMemberships).values([
        {
          id: rid("xm1"),
          labId: xferOrgId,
          userId: xferOwnerId,
          role: "owner",
          status: "active",
          approvedByUserId: xferOwnerId,
          joinedAt: new Date(),
        },
        {
          id: rid("xm2"),
          labId: xferOrgId,
          userId: xferTargetId,
          role: "user",
          status: "active",
          approvedByUserId: xferOwnerId,
          joinedAt: new Date(),
        },
      ]);
    });

    afterAll(async () => {
      const { db, auditLogs, userSessions, organizationMemberships, organizations, users } =
        dbMod as any;
      const xferUserIds = [xferOwnerId, xferTargetId];

      await db.delete(auditLogs).where(eq(auditLogs.organizationId, xferOrgId));
      await db.delete(userSessions).where(inArray(userSessions.userId, xferUserIds));
      await db.delete(organizationMemberships).where(
        eq(organizationMemberships.labId, xferOrgId)
      );
      await db.delete(organizations).where(eq(organizations.id, xferOrgId));
      await db.delete(users).where(inArray(users.id, xferUserIds));
    });

    beforeEach(async () => {
      const { db, organizationMemberships, users } = dbMod;
      await db.update(organizationMemberships).set({ role: "owner", status: "active", deletedAt: null }).where(and(eq(organizationMemberships.labId, xferOrgId), eq(organizationMemberships.userId, xferOwnerId)));
      await db.update(organizationMemberships).set({ role: "user", status: "active", deletedAt: null }).where(and(eq(organizationMemberships.labId, xferOrgId), eq(organizationMemberships.userId, xferTargetId)));
      await db.update(users).set({ isActive: true, deletedAt: null }).where(eq(users.id, xferTargetId));
    });

    async function roles() {
      const { db, organizationMemberships } = dbMod;
      const rows = await db.select().from(organizationMemberships).where(eq(organizationMemberships.labId, xferOrgId));
      return Object.fromEntries(rows.map((m) => [m.userId, m.role]));
    }

    it.each(["wrong phrase", "self", "foreign member", "suspended", "deleted membership", "inactive user"])(
      "rejects %s without changing confirmed roles",
      async (scenario) => {
        const { db, organizationMemberships, users } = dbMod;
        if (scenario === "suspended") await db.update(organizationMemberships).set({ status: "suspended" }).where(and(eq(organizationMemberships.labId, xferOrgId), eq(organizationMemberships.userId, xferTargetId)));
        if (scenario === "deleted membership") await db.update(organizationMemberships).set({ deletedAt: new Date() }).where(and(eq(organizationMemberships.labId, xferOrgId), eq(organizationMemberships.userId, xferTargetId)));
        if (scenario === "inactive user") await db.update(users).set({ isActive: false }).where(eq(users.id, xferTargetId));
        const { access } = await makeSession(xferOwnerId);
        const r = await request(appMod.default).post("/api/owner/transfer-ownership").set("Authorization", `Bearer ${access}`).send({
          organizationId: xferOrgId,
          newOwnerUserId: scenario === "self" ? xferOwnerId : scenario === "foreign member" ? memberUserId : xferTargetId,
          confirmationPhrase: scenario === "wrong phrase" ? "wrong" : xferOrgName,
        });
        expect([400, 404]).toContain(r.status);
        expect(r.body.data?.transferred).not.toBe(true);
        expect(r.body.message ?? r.body.error).toBeTruthy();
        expect(await roles()).toMatchObject({ [xferOwnerId]: "owner", [xferTargetId]: "user" });
      },
    );

    it("rolls back both roles if a transactional audit write fails", async () => {
      const audit = await import("../lib/audit.js");
      const failAudit = vi.spyOn(audit, "writeAuditLogTx").mockRejectedValueOnce(new Error("Simulated transactional failure"));
      try {
        const { access } = await makeSession(xferOwnerId);
        const r = await request(appMod.default).post("/api/owner/transfer-ownership").set("Authorization", `Bearer ${access}`).send({
          organizationId: xferOrgId, newOwnerUserId: xferTargetId, confirmationPhrase: xferOrgName,
        });
        expect(r.status).toBe(500);
        expect(await roles()).toMatchObject({ [xferOwnerId]: "owner", [xferTargetId]: "user" });
      } finally {
        failAudit.mockRestore();
      }
    });

    it("an owner of another organization cannot transfer this organization", async () => {
      const { access } = await makeSession(ownerUserId);
      const r = await request(appMod.default).post("/api/owner/transfer-ownership").set("Authorization", `Bearer ${access}`).send({
        organizationId: xferOrgId, newOwnerUserId: xferTargetId, confirmationPhrase: xferOrgName,
      });
      expect(r.status).toBe(403);
      expect(await roles()).toMatchObject({ [xferOwnerId]: "owner", [xferTargetId]: "user" });
    });

    it("returns 200 + { transferred: true, newOwnerUserId }, updates roles in DB, and writes an audit entry", async () => {
      // An existing multi-owner organization is not normalized to one owner.
      await dbMod.db.insert(dbMod.organizationMemberships).values({
        labId: xferOrgId, userId: nonOwnerUserId, role: "owner", status: "active",
      });
      const { access } = await makeSession(xferOwnerId);
      const { db, organizationMemberships, auditLogs } = dbMod as any;

      const r = await request(appMod.default)
        .post("/api/owner/transfer-ownership")
        .set("Authorization", `Bearer ${access}`)
        .send({
          organizationId: xferOrgId,
          newOwnerUserId: xferTargetId,
          confirmationPhrase: xferOrgName,
        });

      expect(r.status).toBe(200);
      expect(r.body.data).toMatchObject({
        transferred: true,
        newOwnerUserId: xferTargetId,
      });

      // New owner must have role="owner" in the DB
      const newOwnerMembership = await db.query.organizationMemberships.findFirst({
        where: and(
          eq(organizationMemberships.labId, xferOrgId),
          eq(organizationMemberships.userId, xferTargetId)
        ),
      });
      expect(newOwnerMembership?.role).toBe("owner");

      // Former owner must be demoted to role="admin" in the DB
      const formerOwnerMembership = await db.query.organizationMemberships.findFirst({
        where: and(
          eq(organizationMemberships.labId, xferOrgId),
          eq(organizationMemberships.userId, xferOwnerId)
        ),
      });
      expect(formerOwnerMembership?.role).toBe("admin");

      // An audit entry must have been written for this transfer
      const auditEntry = await db.query.auditLogs.findFirst({
        where: and(
          eq(auditLogs.organizationId, xferOrgId),
          eq(auditLogs.action, "owner_transferred_ownership")
        ),
      });
      expect(auditEntry).toBeDefined();
      expect(auditEntry?.userId).toBe(xferOwnerId);
      expect(await roles()).toMatchObject({ [nonOwnerUserId]: "owner" });
      const retry = await request(appMod.default).post("/api/owner/transfer-ownership").set("Authorization", `Bearer ${access}`).send({
        organizationId: xferOrgId, newOwnerUserId: xferTargetId, confirmationPhrase: xferOrgName,
      });
      expect(retry.status).toBe(403);
    });
  });

  // ── POST /api/owner/delete-lab ─────────────────────────────────────────────
  // Uses an intentionally wrong confirmation phrase so the org is not actually
  // deleted, confirming only that the auth gate passes (→ 400).

  it("POST /api/owner/delete-lab — unauthenticated returns 401", async () => {
    const r = await request(appMod.default)
      .post("/api/owner/delete-lab")
      .send({ organizationId: labOrgId, confirmationPhrase: "wrong" });
    expect(r.status).toBe(401);
  });

  it.each(["admin", "billing", "read_only"])(
    "POST /api/owner/delete-lab — non-owner (%s) returns 403",
    async (role) => {
      const { access } = await makeSession(nonOwnerIds[role]);
      const r = await request(appMod.default)
        .post("/api/owner/delete-lab")
        .set("Authorization", `Bearer ${access}`)
        .send({ organizationId: labOrgId, confirmationPhrase: "wrong" });
      expect(r.status).toBe(403);
    }
  );

  it("POST /api/owner/delete-lab — owner passes the auth gate (wrong phrase → 400)", async () => {
    const { access } = await makeSession(ownerUserId);
    const r = await request(appMod.default)
      .post("/api/owner/delete-lab")
      .set("Authorization", `Bearer ${access}`)
      .send({ organizationId: labOrgId, confirmationPhrase: "__intentionally_wrong__" });
    // 400 confirms the RBAC gate was cleared — a 401 or 403 would mean auth failed.
    expect(r.status).toBe(400);
  });

  // ── GET /api/owner/revenue-report ──────────────────────────────────────────

  it("GET /api/owner/revenue-report — unauthenticated returns 401", async () => {
    const r = await request(appMod.default)
      .get(`/api/owner/revenue-report?organizationId=${labOrgId}`);
    expect(r.status).toBe(401);
  });

  it.each(["admin", "billing", "read_only"])(
    "GET /api/owner/revenue-report — non-owner (%s) returns 403",
    async (role) => {
      const { access } = await makeSession(nonOwnerIds[role]);
      const r = await request(appMod.default)
        .get(`/api/owner/revenue-report?organizationId=${labOrgId}`)
        .set("Authorization", `Bearer ${access}`);
      expect(r.status).toBe(403);
    }
  );

  it("GET /api/owner/revenue-report — owner returns 200 with report shape", async () => {
    const { access } = await makeSession(ownerUserId);
    const r = await request(appMod.default)
      .get(`/api/owner/revenue-report?organizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    expect(r.body.data).toBeDefined();
    expect(r.body.data).toHaveProperty("groupBy");
    expect(r.body.data).toHaveProperty("items");
    expect(r.body.data).toHaveProperty("totalRevenue");
    expect(Array.isArray(r.body.data.items)).toBe(true);
  });

  // ── Revenue report COALESCE fix: invoices with null issuedAt ───────────────
  // Regression guard: invoices where issuedAt IS NULL but createdAt falls
  // within the requested period must be counted (not silently excluded).

  describe("revenue-report includes invoices with null issuedAt", () => {
    const nullIssuedInvoiceId = rid("inv-ni");

    beforeAll(async () => {
      const { db, invoices: invoicesTable } = dbMod as any;
      await db.insert(invoicesTable).values({
        id: nullIssuedInvoiceId,
        invoiceNumber: rid("NI-INV"),
        caseId: null,
        labOrganizationId: labOrgId,
        providerOrganizationId: null,
        status: "open",
        subtotal: "1234.56",
        tax: "0.00",
        discount: "0.00",
        total: "1234.56",
        balanceDue: "1234.56",
        issuedAt: null,
        createdByUserId: ownerUserId,
      });
    });

    afterAll(async () => {
      const { db, invoices: invoicesTable } = dbMod as any;
      await db.delete(invoicesTable).where(eq(invoicesTable.id, nullIssuedInvoiceId));
    });

    it("month groupBy includes the invoice in totalRevenue", async () => {
      const { access } = await makeSession(ownerUserId);
      const r = await request(appMod.default)
        .get(
          `/api/owner/revenue-report?organizationId=${labOrgId}&period=month&groupBy=month`
        )
        .set("Authorization", `Bearer ${access}`);
      expect(r.status).toBe(200);
      const total = parseFloat(r.body.data.totalRevenue);
      expect(total).toBeGreaterThanOrEqual(1234.56);
      const invoiceCount: number = r.body.data.items.reduce(
        (s: number, item: any) => s + (item.invoiceCount ?? 0),
        0
      );
      expect(invoiceCount).toBeGreaterThanOrEqual(1);
    });

    it("practice groupBy includes the invoice in totalRevenue", async () => {
      const { access } = await makeSession(ownerUserId);
      const r = await request(appMod.default)
        .get(
          `/api/owner/revenue-report?organizationId=${labOrgId}&period=month&groupBy=practice`
        )
        .set("Authorization", `Bearer ${access}`);
      expect(r.status).toBe(200);
      const total = parseFloat(r.body.data.totalRevenue);
      expect(total).toBeGreaterThanOrEqual(1234.56);
    });

    it("restoration_type groupBy includes the restoration revenue in totalRevenue", async () => {
      const { db, cases: casesTable, caseRestorations: caseRestorationsTable, invoices: invoicesTable, organizations } =
        dbMod as any;
      const rtCaseId = rid("case-rt");
      const rtInvId = rid("inv-rt");
      const rtProvOrgId = rid("prov-rt");

      await db.insert(organizations).values({
        id: rtProvOrgId,
        type: "provider",
        name: rid("RTProvider"),
      });

      await db.insert(casesTable).values({
        id: rtCaseId,
        caseNumber: rid("RT"),
        labOrganizationId: labOrgId,
        providerOrganizationId: rtProvOrgId,
        doctorName: "Dr. RT",
        patientFirstName: "Pat",
        patientLastName: "RT",
        status: "active",
        createdByUserId: ownerUserId,
      });

      await db.insert(caseRestorationsTable).values({
        caseId: rtCaseId,
        toothNumber: "14",
        restorationType: "crown",
        quantity: 1,
        unitPrice: "777.00",
      });

      await db.insert(invoicesTable).values({
        id: rtInvId,
        invoiceNumber: rid("RT-INV"),
        caseId: rtCaseId,
        labOrganizationId: labOrgId,
        providerOrganizationId: null,
        status: "open",
        subtotal: "777.00",
        tax: "0.00",
        discount: "0.00",
        total: "777.00",
        balanceDue: "777.00",
        issuedAt: null,
        createdByUserId: ownerUserId,
      });

      try {
        const { access } = await makeSession(ownerUserId);
        const r = await request(appMod.default)
          .get(
            `/api/owner/revenue-report?organizationId=${labOrgId}&period=month&groupBy=restoration_type`
          )
          .set("Authorization", `Bearer ${access}`);
        expect(r.status).toBe(200);
        const total = parseFloat(r.body.data.totalRevenue);
        expect(total).toBeGreaterThanOrEqual(777);
      } finally {
        await db.delete(invoicesTable).where(eq(invoicesTable.id, rtInvId));
        await db.delete(caseRestorationsTable).where(eq(caseRestorationsTable.caseId, rtCaseId));
        await db.delete(casesTable).where(eq(casesTable.id, rtCaseId));
        await db.delete(organizations).where(eq(organizations.id, rtProvOrgId));
      }
    });
  });
});
