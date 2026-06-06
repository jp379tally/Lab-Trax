/**
 * Integration tests for auth and multi-user lab sessions (regression guard).
 *
 * Skipped when DATABASE_URL is not configured.  All inserted rows are removed
 * in afterAll so the suite is safe to run against a shared dev DB.
 *
 * Coverage:
 *  - POST /api/auth/login — correct credentials return access + refresh tokens
 *    and create a server-side session
 *  - POST /api/auth/login — wrong password returns 401; unknown username returns 401
 *  - POST /api/auth/login — identifier field matches platformAccountNumber (cross-lab login)
 *  - POST /api/auth/refresh — valid refresh token returns a new access token;
 *    expired/revoked token returns 401
 *  - Two concurrent sessions for the same user both work independently
 *  - POST /api/auth/logout — invalidates the session; subsequent requests return 401
 *  - GET /api/auth/me — returns the correct user for a valid token
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";
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
  caseMediaDir: path.join(require("os").tmpdir(), "labtrax-test-media-auth"),
  extractMediaFileName: () => null,
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("Auth and multi-user lab sessions (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let authLib: typeof import("../lib/auth.js");

  const labOrgId = rid("lab");
  const otherLabOrgId = rid("lab2");
  const providerOrgId = rid("prov");

  const USER_PASSWORD = "CorrectPassword123!";
  const ACCOUNT_NUMBER = `9999${randomBytes(2).toString("hex").toUpperCase()}`;

  const userAId = rid("ua");
  const userBId = rid("ub");
  const userWithAcctId = rid("uc");
  const softDeletedMemberUserId = rid("usd");

  // Helper: manually create a session and return a valid access + refresh token pair.
  // The refresh token is SHA-256 hashed before storing so the /refresh endpoint can
  // look it up (matches the makeSessionHash pattern in auth.ts).
  async function makeSession(userId: string): Promise<{ access: string; refresh: string }> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const refresh = authLib.signRefreshToken(userId, sessionId);
    const hash = createHash("sha256").update(refresh).digest("hex");
    await db.insert(userSessions).values({
      id: sessionId,
      userId,
      tokenHash: hash,
      expiresAt,
    });
    const access = authLib.signAccessToken(userId, sessionId);
    return { access, refresh };
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-auth-session";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    authLib = await import("../lib/auth.js");

    const bcrypt = await import("bcryptjs");
    const hashedPassword = await bcrypt.default.hash(USER_PASSWORD, 10);

    const { db, organizations, users, organizationMemberships } = dbMod as any;

    // Passwords must be stored as bcrypt hashes — the login handler calls
    // bcrypt.compare(input, stored) which returns false for plain-text values.
    await db.insert(users).values([
      {
        id: userAId,
        username: `ua_${userAId}`,
        password: hashedPassword,
      },
      {
        id: userBId,
        username: `ub_${userBId}`,
        password: hashedPassword,
      },
      {
        id: userWithAcctId,
        username: `uc_${userWithAcctId}`,
        password: hashedPassword,
        platformAccountNumber: ACCOUNT_NUMBER,
      },
      {
        id: softDeletedMemberUserId,
        username: `usd_${softDeletedMemberUserId}`,
        password: hashedPassword,
      },
    ]);

    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: "Auth Session Test Lab" },
      { id: otherLabOrgId, type: "lab", name: "Auth Other Lab" },
      { id: providerOrgId, type: "provider", name: "Test Practice", parentLabOrganizationId: labOrgId },
    ]);

    await db.insert(organizationMemberships).values([
      { id: rid("m"), labId: labOrgId, userId: userAId, role: "admin", status: "active" },
      // Soft-deleted membership: status is still "active" but deletedAt is set —
      // this replicates the exact condition that caused the "Join a lab" banner bug.
      {
        id: rid("msd"),
        labId: labOrgId,
        userId: softDeletedMemberUserId,
        role: "staff",
        status: "active",
        deletedAt: new Date(),
        deletedByUserId: userAId,
      },
    ]);
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const {
      db,
      organizations,
      users,
      organizationMemberships,
      userSessions,
      auditLogs,
      invoices,
    } = dbMod as any;
    // invoices.labOrganizationId is onDelete:restrict — must go before orgs.
    await db.delete(auditLogs).where(
      inArray(auditLogs.organizationId, [labOrgId, otherLabOrgId])
    );
    await db.delete(invoices).where(
      inArray(invoices.labOrganizationId, [labOrgId, otherLabOrgId, providerOrgId])
    );
    await db.delete(userSessions).where(
      inArray(userSessions.userId, [userAId, userBId, userWithAcctId, softDeletedMemberUserId])
    );
    await db.delete(organizationMemberships).where(
      inArray(organizationMemberships.userId, [userAId, userBId, userWithAcctId, softDeletedMemberUserId])
    );
    await db.delete(organizations).where(
      inArray(organizations.id, [labOrgId, otherLabOrgId, providerOrgId])
    );
    await db.delete(users).where(
      inArray(users.id, [userAId, userBId, userWithAcctId, softDeletedMemberUserId])
    );
  });

  // ── POST /api/auth/login ──────────────────────────────────────────────────

  it("login with correct credentials returns access + refresh tokens and creates a session", async () => {
    const r = await request(appMod.default)
      .post("/api/auth/login")
      .send({ identifier: `ua_${userAId}`, password: USER_PASSWORD, clientType: "mobile" });

    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(typeof r.body.accessToken).toBe("string");
    expect(typeof r.body.refreshToken).toBe("string");
    expect(r.body.user.id).toBe(userAId);

    // Clean up the session created by this login.
    const { db, userSessions } = dbMod as any;
    const payload = authLib.verifyRefreshToken(r.body.refreshToken);
    await db.delete(userSessions).where(eq(userSessions.id, payload.sid));
  });

  it("login with wrong password returns 401", async () => {
    const r = await request(appMod.default)
      .post("/api/auth/login")
      .send({ identifier: `ua_${userAId}`, password: "WrongPassword!" });

    expect(r.status).toBe(401);
  });

  it("login with unknown username returns 401", async () => {
    const r = await request(appMod.default)
      .post("/api/auth/login")
      .send({ identifier: "no_such_user_xyz123", password: USER_PASSWORD });

    expect(r.status).toBe(401);
  });

  it("login with identifier = platformAccountNumber succeeds (cross-lab login)", async () => {
    const r = await request(appMod.default)
      .post("/api/auth/login")
      .send({ identifier: ACCOUNT_NUMBER, password: USER_PASSWORD, clientType: "mobile" });

    expect(r.status).toBe(200);
    expect(r.body.user.id).toBe(userWithAcctId);

    const { db, userSessions } = dbMod as any;
    const payload = authLib.verifyRefreshToken(r.body.refreshToken);
    await db.delete(userSessions).where(eq(userSessions.id, payload.sid));
  });

  // ── POST /api/auth/refresh ────────────────────────────────────────────────

  it("refresh with a valid refresh token returns a new access token", async () => {
    const { access: _a, refresh } = await makeSession(userAId);

    const r = await request(appMod.default)
      .post("/api/auth/refresh")
      .send({ refreshToken: refresh });

    expect(r.status).toBe(200);
    expect(typeof r.body.data.accessToken).toBe("string");

    // Clean up rotated session.
    const { db, userSessions } = dbMod as any;
    const payload = authLib.verifyRefreshToken(r.body.data.refreshToken);
    await db.delete(userSessions).where(eq(userSessions.id, payload.sid));
  });

  it("refresh with a revoked/non-existent session returns 401", async () => {
    // Fabricate a well-formed refresh token whose session does not exist in DB.
    const fakeRefresh = authLib.signRefreshToken(userAId, rid("ghost"));

    const r = await request(appMod.default)
      .post("/api/auth/refresh")
      .send({ refreshToken: fakeRefresh });

    expect(r.status).toBe(401);
  });

  it("refresh with a completely invalid token string returns 401", async () => {
    const r = await request(appMod.default)
      .post("/api/auth/refresh")
      .send({ refreshToken: "not.a.valid.jwt" });

    expect(r.status).toBe(401);
  });

  // ── Concurrent sessions ───────────────────────────────────────────────────

  it("two concurrent sessions for the same user both work independently", async () => {
    const session1 = await makeSession(userAId);
    const session2 = await makeSession(userAId);

    const [r1, r2] = await Promise.all([
      request(appMod.default)
        .get("/api/auth/me")
        .set("Authorization", `Bearer ${session1.access}`),
      request(appMod.default)
        .get("/api/auth/me")
        .set("Authorization", `Bearer ${session2.access}`),
    ]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r1.body.user.id).toBe(userAId);
    expect(r2.body.user.id).toBe(userAId);

    const { db, userSessions } = dbMod as any;
    const p1 = authLib.verifyRefreshToken(session1.refresh);
    const p2 = authLib.verifyRefreshToken(session2.refresh);
    await db.delete(userSessions).where(inArray(userSessions.id, [p1.sid, p2.sid]));
  });

  // ── POST /api/auth/logout ─────────────────────────────────────────────────

  it("logout invalidates the session; subsequent requests return 401", async () => {
    const { access, refresh } = await makeSession(userAId);

    const logout = await request(appMod.default)
      .post("/api/auth/logout")
      .set("Authorization", `Bearer ${access}`);

    expect(logout.status).toBe(200);
    expect(logout.body.data.loggedOut).toBe(true);

    // The same access token must no longer be accepted after logout.
    const me = await request(appMod.default)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${access}`);

    expect(me.status).toBe(401);

    // Refresh with the old refresh token must also fail.
    const reuse = await request(appMod.default)
      .post("/api/auth/refresh")
      .send({ refreshToken: refresh });

    expect(reuse.status).toBe(401);
  });

  // ── GET /api/auth/me ──────────────────────────────────────────────────────

  it("GET /api/auth/me returns the correct user", async () => {
    const { access, refresh } = await makeSession(userAId);

    const r = await request(appMod.default)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${access}`);

    expect(r.status).toBe(200);
    expect(r.body.user.id).toBe(userAId);

    const { db, userSessions } = dbMod as any;
    const p = authLib.verifyRefreshToken(refresh);
    await db.delete(userSessions).where(eq(userSessions.id, p.sid));
  });

  it("GET /api/auth/me returns 401 when no token is provided", async () => {
    const r = await request(appMod.default).get("/api/auth/me");
    expect(r.status).toBe(401);
  });

  it("GET /api/auth/me with a token from a user in org A cannot see org B memberships", async () => {
    // userB has no org memberships — its /me response must not contain labOrgId (userA's org).
    const { access, refresh } = await makeSession(userBId);

    const r = await request(appMod.default)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${access}`);

    expect(r.status).toBe(200);
    const orgIds = (r.body.memberships ?? []).map((m: any) => m.organizationId);
    expect(orgIds).not.toContain(labOrgId);

    const { db, userSessions } = dbMod as any;
    const p = authLib.verifyRefreshToken(refresh);
    await db.delete(userSessions).where(eq(userSessions.id, p.sid));
  });

  // ── Soft-deleted membership regression ───────────────────────────────────
  // Regression guard for the "Join a lab" banner bug: a membership row with
  // deletedAt set must be invisible to /api/auth/me and must not grant
  // case-read access via fetchUserActiveLabIds.

  it("GET /api/auth/me excludes soft-deleted memberships from the response", async () => {
    const { access, refresh } = await makeSession(softDeletedMemberUserId);

    const r = await request(appMod.default)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${access}`);

    expect(r.status).toBe(200);
    // The soft-deleted membership must not appear — memberships array must be empty.
    expect(r.body.memberships).toEqual([]);

    const { db, userSessions } = dbMod as any;
    const p = authLib.verifyRefreshToken(refresh);
    await db.delete(userSessions).where(eq(userSessions.id, p.sid));
  });

  it("GET /api/cases excludes lab cases for a user whose only membership is soft-deleted", async () => {
    const { db, cases: casesTable, userSessions } = dbMod as any;

    // Insert a case in the lab that the soft-deleted member no longer belongs to.
    const caseId = rid("sdc");
    await db.insert(casesTable).values({
      id: caseId,
      caseNumber: rid("SDC"),
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      patientFirstName: "Soft",
      patientLastName: "Deleted",
      doctorName: "Dr. SoftDelete",
      status: "received",
      createdByUserId: userAId,
    });

    const { access, refresh } = await makeSession(softDeletedMemberUserId);

    // Do NOT pass organizationId — let the server derive orgs from the user's
    // memberships. Passing an explicit org bypasses membership checks entirely;
    // the membership-lookup path is what fetchUserActiveLabIds guards.
    const r = await request(appMod.default)
      .get("/api/cases")
      .set("Authorization", `Bearer ${access}`);

    // After fixing the soft-delete filter, the user has no active lab IDs so
    // the response must be 200 with an empty list (or at most contain no
    // cases from the lab they were soft-deleted from).
    const ids =
      r.status === 200 ? (r.body.data ?? []).map((c: any) => c.id) : [];
    expect(ids).not.toContain(caseId);

    // Clean up the test-inserted case and session.
    const p = authLib.verifyRefreshToken(refresh);
    await Promise.all([
      db.delete(casesTable).where(eq(casesTable.id, caseId)),
      db.delete(userSessions).where(eq(userSessions.id, p.sid)),
    ]);
  });
});
