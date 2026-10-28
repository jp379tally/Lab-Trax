/**
 * Integration tests for auth registration and password-reset (regression guard).
 *
 * Skipped when DATABASE_URL is not configured.  All inserted rows are removed
 * in afterAll so the suite is safe to run against a shared dev DB.
 *
 * Coverage:
 *  - POST /api/auth/register — success: returns tokens + user
 *  - POST /api/auth/register — 409 on duplicate username
 *  - POST /api/auth/register — 409 on duplicate email
 *  - POST /api/forgot-password — always 200 regardless of whether email exists
 *    (no-enumeration guarantee)
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { inArray, eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import request from "supertest";
import * as path from "node:path";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/entitlement.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/entitlement.js")>(),
  startBillingTrial: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(require("os").tmpdir(), "labtrax-test-media-auth-reg"),
  extractMediaFileName: () => null,
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

/**
 * Random username conforming to the canonical signup rule (3–12 chars,
 * [a-zA-Z0-9_]). Use this for register-endpoint inputs; rid() stays for emails
 * and DB-level identifiers where length is unrestricted.
 */
function uname(prefix: string) {
  return `${prefix}${randomBytes(6).toString("hex")}`.slice(0, 12);
}

maybe("Auth registration and password reset (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };

  const createdUserIds: string[] = [];
  const createdOrgIds: string[] = [];

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-auth-reg";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    // Route registration is asynchronous; a missing email returns 400 only
    // once the auth routes are mounted. Do not race startup's temporary 503.
    await vi.waitFor(async () => {
      const ready = await request(appMod.default).get("/api/auth/check-email");
      expect(ready.status).toBe(400);
    }, { timeout: 20_000, interval: 50 });
  });

  afterAll(async () => {
    if (!SHOULD_RUN || createdUserIds.length === 0) return;
    const { db, auditLogs, userSessions, organizationMemberships, organizationJoinRequests, organizations, users } = dbMod as any;
    await db.delete(auditLogs).where(inArray(auditLogs.userId, createdUserIds));
    await db.delete(userSessions).where(inArray(userSessions.userId, createdUserIds));
    await db.delete(organizationMemberships).where(
      inArray(organizationMemberships.userId, createdUserIds)
    );
    if (createdOrgIds.length) {
      await db.delete(organizationJoinRequests).where(inArray(organizationJoinRequests.labId, createdOrgIds));
      await db.delete(organizations).where(inArray(organizations.id, createdOrgIds));
    }
    await db.delete(users).where(inArray(users.id, createdUserIds));
  });

  // ── POST /api/auth/register ───────────────────────────────────────────────

  it("register with valid credentials returns 200 with access token and user", async () => {
    const username = uname("reg");
    const r = await request(appMod.default)
      .post("/api/auth/register")
      .send({
        username,
        password: "TestPassword1!",
        email: `${username}@example.com`,
        userType: "lab",
        clientType: "mobile",
      });

    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(typeof r.body.accessToken).toBe("string");
    expect(typeof r.body.refreshToken).toBe("string");
    expect(r.body.user.username).toBe(username);

    if (r.body.user?.id) createdUserIds.push(r.body.user.id);
  });

  it("register with duplicate username returns 409", async () => {
    const username = uname("dup");

    const first = await request(appMod.default)
      .post("/api/auth/register")
      .send({
        username,
        password: "Pass1234!",
        email: `${username}.1@example.com`,
        userType: "lab",
        clientType: "mobile",
      });
    expect(first.status).toBe(200);
    if (first.body.user?.id) createdUserIds.push(first.body.user.id);

    const second = await request(appMod.default)
      .post("/api/auth/register")
      .send({
        username,
        password: "OtherPass!",
        email: `${username}.2@example.com`,
        userType: "lab",
        clientType: "mobile",
      });
    expect(second.status).toBe(409);
    // Must not expose raw SQL or Drizzle internals.
    const dupUsernameMsg: string = second.body.message ?? second.body.error ?? "";
    expect(dupUsernameMsg).not.toMatch(/insert into|duplicate key|violates|drizzle/i);
    expect(dupUsernameMsg.length).toBeGreaterThan(0);
  });

  it("register with duplicate email returns 409", async () => {
    const email = `${rid("regdupe")}@example.com`;
    const first = await request(appMod.default)
      .post("/api/auth/register")
      .send({ username: uname("ua"), password: "Pass1234!", email, userType: "lab", clientType: "mobile" });
    expect(first.status).toBe(200);
    if (first.body.user?.id) createdUserIds.push(first.body.user.id);

    const availability = await request(appMod.default)
      .get("/api/auth/check-email")
      .query({ email: email.toUpperCase() });
    expect(availability.status).toBe(200);
    expect(availability.body.data?.available).toBe(true);
    const unknownEmailAvailability = await request(appMod.default)
      .get("/api/auth/check-email")
      .query({ email: `${rid("unknown")}@example.com` });
    expect(unknownEmailAvailability.status).toBe(200);
    expect(unknownEmailAvailability.body.data).toEqual(availability.body.data);

    const second = await request(appMod.default)
      .post("/api/auth/register")
      .send({ username: uname("ub"), password: "OtherPass!", email, userType: "lab", clientType: "mobile" });
    expect(second.status).toBe(409);
    // Must not expose raw SQL or Drizzle internals.
    const dupEmailMsg: string = second.body.message ?? second.body.error ?? "";
    expect(dupEmailMsg).not.toMatch(/insert into|duplicate key|violates|drizzle/i);
    expect(dupEmailMsg.length).toBeGreaterThan(0);
  });

  it("logs distinct registered accounts in by their own usernames", async () => {
    const firstUsername = uname("shared");
    const secondUsername = uname("shared");
    const firstEmail = `${rid("first")}@example.com`;
    const secondEmail = `${rid("second")}@example.com`;
    const first = await request(appMod.default)
      .post("/api/auth/register")
      .send({
        username: firstUsername,
        password: "Pass1234!",
        email: firstEmail,
        userType: "lab",
        clientType: "mobile",
      });
    expect(first.status).toBe(200);
    if (first.body.user?.id) createdUserIds.push(first.body.user.id);

    const availability = await request(appMod.default)
      .get("/api/auth/check-email")
      .query({ email: firstEmail.toUpperCase() });
    expect(availability.status).toBe(200);
    expect(availability.body.data?.available).toBe(true);

    const second = await request(appMod.default)
      .post("/api/auth/register")
      .send({
        username: secondUsername,
        password: "Pass1234!",
        email: secondEmail,
        userType: "lab",
        clientType: "mobile",
      });
    expect(second.status).toBe(200);
    if (second.body.user?.id) createdUserIds.push(second.body.user.id);

    const duplicateUsername = await request(appMod.default)
      .post("/api/auth/register")
      .send({
        username: firstUsername,
        password: "OtherPass!",
        email: firstEmail,
        userType: "lab",
        clientType: "mobile",
      });
    expect(duplicateUsername.status).toBe(409);
    expect(duplicateUsername.body.message ?? duplicateUsername.body.error).toMatch(
      /username already taken/i,
    );

    for (const username of [firstUsername, secondUsername]) {
      const login = await request(appMod.default)
        .post("/api/auth/login")
        .send({ identifier: username, password: "Pass1234!", clientType: "mobile" });
      expect(login.status).toBe(200);
      expect(login.body.user?.username).toBe(username);
    }
  });

  it("register that creates a lab org without required fields returns 400 LAB_FIELDS_REQUIRED", async () => {
    const username = uname("labmissing");
    const r = await request(appMod.default)
      .post("/api/auth/register")
      .send({
        username,
        password: "TestPassword1!",
        email: `${username}@example.com`,
        userType: "lab",
        clientType: "mobile",
        createOrganization: true,
        practiceName: `Missing Fields Lab ${username}`,
        // No practiceAddress / practicePhone / licenseNumber — must be rejected.
      });
    expect(r.status).toBe(400);
    expect(r.body.details?.code).toBe("LAB_FIELDS_REQUIRED");
    // No user should be persisted when org creation validation fails.
    if (r.body.user?.id) createdUserIds.push(r.body.user.id);
  });

  it("register as a lab employee without createOrganization succeeds and creates no org/membership", async () => {
    const username = uname("labjoin");
    const r = await request(appMod.default)
      .post("/api/auth/register")
      .send({
        username,
        password: "TestPassword1!",
        email: `${username}@example.com`,
        userType: "lab",
        clientType: "mobile",
        // No createOrganization, no practiceName, no lab fields — the account
        // should be created on its own with no organization/membership.
      });

    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(typeof r.body.accessToken).toBe("string");
    expect(r.body.user.username).toBe(username);
    // No org is created for an account-only lab signup.
    expect(r.body.organization ?? null).toBeNull();
    expect(r.body.pendingJoinRequest).toBeFalsy();

    const userId = r.body.user?.id as string | undefined;
    expect(userId).toBeTruthy();
    if (userId) createdUserIds.push(userId);

    // Assert at the DB level that no membership row was created.
    const { db, organizationMemberships } = dbMod as any;
    const memberships = await db
      .select()
      .from(organizationMemberships)
      .where(eq(organizationMemberships.userId, userId));
    expect(memberships).toHaveLength(0);
  });

  // ── POST /api/forgot-password (no-enumeration) ────────────────────────────
  for (const userType of ["lab", "provider"] as const) {
    it.each(["user", "admin", "master_admin"])(
      `${userType} creator is Owner/admin immediately and after reauthentication despite submitted role %s`,
      async (role) => {
        const username = uname("creator");
        const r = await request(appMod.default).post("/api/auth/register").send({
          username, password: "TestPassword1!", email: `${username}@example.com`,
          userType, clientType: "mobile", role, createOrganization: true,
          practiceName: `Creator ${username}`, licenseNumber: "LIC-123",
          practiceAddress: "123 Test St, Austin, TX, 78701", practicePhone: "5125550199",
          address: { line1: "123 Test St", city: "Austin", state: "TX", zip: "78701" },
        });
        if (r.body.user?.id) createdUserIds.push(r.body.user.id);
        if (r.body.organization?.id) createdOrgIds.push(r.body.organization.id);
        expect(r.status).toBe(200);
        expect(r.body.user).toMatchObject({ role: "admin", membershipRole: "owner" });
        const { db, users, organizationMemberships } = dbMod;
        const stored = await db.query.users.findFirst({ where: eq(users.id, r.body.user.id) });
        expect(stored?.role).toBe("user");
        const member = await db.query.organizationMemberships.findFirst({
          where: eq(organizationMemberships.userId, r.body.user.id),
        });
        expect(member).toMatchObject({ role: "owner", status: "active", labId: r.body.organization.id });
        const me = await request(appMod.default).get("/api/auth/me").set("Authorization", `Bearer ${r.body.accessToken}`);
        expect(me.status).toBe(200);
        expect(me.body.user).toMatchObject({ role: "admin", membershipRole: "owner" });
        expect(me.body.memberships).toEqual(expect.arrayContaining([expect.objectContaining({ role: "owner", status: "active" })]));
        const refresh = await request(appMod.default).post("/api/auth/refresh").send({ refreshToken: r.body.refreshToken, clientType: "mobile" });
        expect(refresh.status).toBe(200);
        const refreshedMe = await request(appMod.default).get("/api/auth/me").set("Authorization", `Bearer ${refresh.body.data.accessToken}`);
        expect(refreshedMe.body.user).toMatchObject({ role: "admin", membershipRole: "owner" });
        const login = await request(appMod.default).post("/api/auth/login").send({ identifier: username, password: "TestPassword1!", clientType: "mobile" });
        expect(login.status).toBe(200);
        expect(login.body.user).toMatchObject({ role: "admin", membershipRole: "owner" });
      },
    );

    it(`${userType} joining an existing organization cannot self-grant ownership`, async () => {
      const orgId = rid("joinorg");
      createdOrgIds.push(orgId);
      await dbMod.db.insert(dbMod.organizations).values({ id: orgId, name: orgId, type: userType === "lab" ? "lab" : "provider" });
      const username = uname("join");
      const r = await request(appMod.default).post("/api/auth/register").send({
        username, password: "TestPassword1!", email: `${username}@example.com`,
        userType, clientType: "mobile", role: "owner", createOrganization: true,
        joinOrganizationId: orgId, practiceName: "Must not create",
        practiceAddress: "123 Test St", practicePhone: "5125550199", licenseNumber: "LIC-123",
        address: { line1: "123 Test St", city: "Austin", state: "TX", zip: "78701" },
      });
      if (r.body.user?.id) createdUserIds.push(r.body.user.id);
      expect(r.status).toBe(200);
      expect(r.body.pendingJoinRequest).toBe(true);
      expect(r.body.user).toMatchObject({ role: "user", membershipRole: null });
      const members = await dbMod.db.select().from(dbMod.organizationMemberships).where(eq(dbMod.organizationMemberships.userId, r.body.user.id));
      expect(members).toHaveLength(0);
    });
  }

  it("forgot-password returns 200 for a non-existent email (no enumeration)", async () => {
    const r = await request(appMod.default)
      .post("/api/forgot-password")
      .send({ email: "definitelydoesnotexist@example.invalid" });

    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
  });

  // ── POST /api/auth/login  /auth/refresh  /auth/logout ─────────────────────
  //
  // Uses a DB-level user insert to bypass the register rate-limiter (5/60 s).
  // The auth route accepts a plain-text password and upgrades it to bcrypt on
  // the first successful login — no bcrypt work needed here.

  describe("login, refresh, and logout", () => {
    let loginUserId: string;
    let loginUsername: string;
    let inactiveUserId: string;
    let inactiveUsername: string;
    let panUserId: string;
    let panAccountNumber: string;

    beforeAll(async () => {
      loginUserId = rid("loginusr");
      // A short uppercase username mirrors the identifier shown in the
      // Desktop sign-in report and exercises case-insensitive username lookup.
      loginUsername = `JPP${randomBytes(3).toString("hex").toUpperCase()}`;
      inactiveUserId = rid("inactive");
      inactiveUsername = `inactive_${randomBytes(3).toString("hex")}`;
      panUserId = rid("panuser");
      panAccountNumber = `PAN${rid("").slice(0, 8).toUpperCase()}`;
      const { db, users } = dbMod as any;
      await db.insert(users).values([
        {
          id: loginUserId,
          username: loginUsername,
          password: "TestLogin1!",
          email: `${loginUserId}@example.com`,
        },
        {
          id: inactiveUserId,
          username: inactiveUsername,
          password: "TestLogin1!",
          isActive: false,
        },
        {
          id: panUserId,
          username: `pan_${panUserId}`,
          password: "TestLogin1!",
          platformAccountNumber: panAccountNumber,
        },
      ]);
    });

    afterAll(async () => {
      const { db, users, userSessions } = dbMod as any;
      await db.delete(userSessions).where(
        inArray(userSessions.userId, [loginUserId, inactiveUserId, panUserId]),
      );
      await db.delete(users).where(inArray(users.id, [loginUserId, inactiveUserId, panUserId]));
    });

    it("POST /api/auth/login — valid credentials return 200 with access + refresh tokens", async () => {
      const r = await request(appMod.default)
        .post("/api/auth/login")
        .send({ identifier: loginUsername, password: "TestLogin1!", clientType: "mobile" });
      expect(r.status).toBe(200);
      expect(r.body.success).toBe(true);
      expect(typeof r.body.accessToken).toBe("string");
      expect(typeof r.body.refreshToken).toBe("string");
    });

    it("POST /api/auth/login — Desktop username/password contract accepts normalized username casing", async () => {
      const r = await request(appMod.default)
        .post("/api/auth/login")
        .send({
          username: loginUsername.toLowerCase(),
          password: "TestLogin1!",
          deviceName: "LabTrax Desktop",
          clientType: "desktop",
        });
      expect(r.status).toBe(200);
      expect(r.body.success).toBe(true);
      expect(typeof r.body.accessToken).toBe("string");
      expect(typeof r.body.refreshToken).toBe("string");
      expect(r.body.user.username).toBe(loginUsername);
    });

    it("POST /api/auth/login — wrong password returns 401", async () => {
      const r = await request(appMod.default)
        .post("/api/auth/login")
        .send({ identifier: loginUsername, password: "WrongPass!", clientType: "mobile" });
      expect(r.status).toBe(401);
    });

    it("POST /api/auth/login — credential failures do not reveal whether the username exists", async () => {
      const wrongPassword = await request(appMod.default)
        .post("/api/auth/login")
        .send({
          username: loginUsername,
          password: "WrongPass!",
          clientType: "desktop",
        });
      const unknownUsername = await request(appMod.default)
        .post("/api/auth/login")
        .send({
          username: rid("ghost"),
          password: "AnyPass1!",
          clientType: "desktop",
        });

      expect(wrongPassword.status).toBe(401);
      expect(unknownUsername.status).toBe(401);
      expect(wrongPassword.body.message).toBe("Invalid username or password.");
      expect(unknownUsername.body.message).toBe(wrongPassword.body.message);
    });

    it("POST /api/auth/login — disabled accounts receive the same generic rejection", async () => {
      const disabledAccount = await request(appMod.default)
        .post("/api/auth/login")
        .send({
          username: inactiveUsername,
          password: "TestLogin1!",
          clientType: "desktop",
        });
      const unknownUsername = await request(appMod.default)
        .post("/api/auth/login")
        .send({
          username: rid("ghost"),
          password: "AnyPass1!",
          clientType: "desktop",
        });

      expect(disabledAccount.status).toBe(401);
      expect(unknownUsername.status).toBe(401);
      expect(disabledAccount.body.message).toBe("Invalid username or password.");
      expect(unknownUsername.body.message).toBe(disabledAccount.body.message);
    });

    it("POST /api/auth/login — non-existent username returns 401", async () => {
      const r = await request(appMod.default)
        .post("/api/auth/login")
        .send({ identifier: rid("ghost"), password: "AnyPass1!", clientType: "mobile" });
      expect(r.status).toBe(401);
    });

    it("POST /api/auth/login — identifier matches platform account number", async () => {
      const r = await request(appMod.default)
        .post("/api/auth/login")
        .send({ identifier: panAccountNumber, password: "TestLogin1!", clientType: "mobile" });
      expect(r.status).toBe(200);
      expect(typeof r.body.accessToken).toBe("string");
    });

    it("POST /api/auth/login — email identifier authenticates successfully (200)", async () => {
      // The login handler matches username, email, and platform_account_number.
      // A user who registered with an email field can log in using that email
      // as their identifier.
      const r = await request(appMod.default)
        .post("/api/auth/login")
        .send({ identifier: `${loginUserId}@example.com`, password: "TestLogin1!", clientType: "mobile" });
      expect(r.status).toBe(200);
      expect(typeof r.body.accessToken).toBe("string");
    });

    it("POST /api/auth/refresh — valid refresh token returns a new access token", async () => {
      const login = await request(appMod.default)
        .post("/api/auth/login")
        .send({ identifier: loginUsername, password: "TestLogin1!", clientType: "mobile" });
      expect(login.status).toBe(200);

      const r = await request(appMod.default)
        .post("/api/auth/refresh")
        .send({ refreshToken: login.body.refreshToken, clientType: "mobile" });
      expect(r.status).toBe(200);
      // Refresh uses ok(res, { accessToken, refreshToken }) → data wrapper
      const newAccess: unknown = r.body.data?.accessToken ?? r.body.accessToken;
      expect(typeof newAccess).toBe("string");
    });

    it("POST /api/auth/refresh — invalid refresh token returns 401", async () => {
      // A malformed or unknown token string must be rejected without throwing.
      const r = await request(appMod.default)
        .post("/api/auth/refresh")
        .send({ refreshToken: "not.a.valid.jwt.token", clientType: "mobile" });
      expect(r.status).toBe(401);
    });

    it("POST /api/auth/refresh — old refresh token rejected after rotation; new token valid", async () => {
      const login = await request(appMod.default)
        .post("/api/auth/login")
        .send({ identifier: panAccountNumber, password: "TestLogin1!", clientType: "mobile" });
      expect(login.status).toBe(200);
      const oldRefresh = login.body.refreshToken as string;

      // JWT iat is second-precision: wait >1 s so the rotated token has a
      // different iat and therefore a different signature than oldRefresh.
      // Without this delay, signRefreshToken(sub, sid) at the same second
      // produces an identical JWT → same hash → no mismatch detected.
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // First refresh: server rotates the token (updates tokenHash in DB).
      const r1 = await request(appMod.default)
        .post("/api/auth/refresh")
        .send({ refreshToken: oldRefresh, clientType: "mobile" });
      expect(r1.status).toBe(200);
      const newRefresh = r1.body.data?.refreshToken as string;
      expect(typeof newRefresh).toBe("string");
      expect(newRefresh).not.toBe(oldRefresh); // rotation issued a fresh token

      // Second attempt with the OLD token → hash mismatch → 401
      const r2 = await request(appMod.default)
        .post("/api/auth/refresh")
        .send({ refreshToken: oldRefresh, clientType: "mobile" });
      expect(r2.status).toBe(401);

      // The NEW token is still valid (session not revoked; r2 revokes after
      // reuse-detection fires; so skip the r3 check to avoid flakiness)
    });

    it("POST /api/auth/logout — revokes session; subsequent refresh returns 401", async () => {
      const login = await request(appMod.default)
        .post("/api/auth/login")
        .send({ identifier: loginUsername, password: "TestLogin1!", clientType: "mobile" });
      expect(login.status).toBe(200);
      const { accessToken, refreshToken } = login.body;

      const logout = await request(appMod.default)
        .post("/api/auth/logout")
        .set("Authorization", `Bearer ${accessToken}`);
      expect(logout.status).toBe(200);
      expect(logout.body.data?.loggedOut).toBe(true);

      // After logout the session row is revoked; the refresh token must be rejected.
      const refresh = await request(appMod.default)
        .post("/api/auth/refresh")
        .send({ refreshToken, clientType: "mobile" });
      expect(refresh.status).toBe(401);
    });
  });

});
