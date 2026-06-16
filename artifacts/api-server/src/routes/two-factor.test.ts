/**
 * DB-backed behavioural tests for the SMS/authenticator two-factor (2FA)
 * workflow — Account epic Phase 6 regression guard.
 *
 * Skipped when DATABASE_URL is not configured. All inserted rows are removed
 * in afterAll so the suite is safe to run against a shared dev DB.
 *
 * Coverage (Protected Workflow: Two-Factor Authentication Challenge):
 *  - GET  /api/auth/2fa/status — defaults to disabled for a fresh account.
 *  - POST /api/auth/2fa/setup — returns a TOTP secret (auth required).
 *  - POST /api/auth/2fa/confirm — wrong code 422; valid TOTP enables 2FA and
 *    returns 8 single-use backup codes.
 *  - POST /api/auth/login — once 2FA is enabled, login returns
 *    { requiresTwoFactor: true, pendingToken } instead of a session.
 *  - POST /api/auth/2fa/challenge — invalid pendingToken 401; wrong code 422;
 *    valid TOTP issues bearer tokens; a backup code also works (single-use).
 *  - DELETE /api/auth/2fa — valid TOTP disables 2FA; status returns to false.
 *  - DELETE /api/auth/2fa — disabling 2FA forgets ALL trusted devices: the
 *    `trusted_devices` rows are purged and a previously-issued device-trust
 *    token cannot survive a disable/re-enable cycle (still forces a challenge).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { inArray, eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { generateSync, generateSecret } from "otplib";
import request from "supertest";
import * as path from "node:path";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(require("os").tmpdir(), "labtrax-test-media-2fa"),
  extractMediaFileName: () => null,
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

// These are ordered, multi-request DB-integration tests. Under full-suite
// contention (parallel DB suites + email MX-lookup latency from sibling
// verification tests) a single test fires 4–5 sequential HTTP round-trips and
// can exceed vitest's default 5s budget, which then cascades into the ordered
// tests that depend on the captured secret/backup codes. Give them headroom.
// Per-file timeouts must stay at or above the global hookTimeout (90 s) so
// two concurrent test workflows (api-server-tests + regression-tests) can
// both wait out DB-pool contention without timing out.  The original 30 s
// cap caused beforeAll hook failures when the pool was temporarily saturated.
vi.setConfig({ testTimeout: 60000, hookTimeout: 90000 });

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("Two-factor authentication (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let authLib: typeof import("../lib/auth.js");
  let cryptoLib: typeof import("../lib/crypto.js");

  const userId = rid("u2fa");
  const username = `tfa_${randomBytes(3).toString("hex")}`;
  const password = "TestPass1!";

  // Captured across ordered tests.
  let secret = "";
  let backupCodes: string[] = [];
  let deviceTrustToken = "";

  // Extra throwaway users created inside individual tests (cleaned in afterAll).
  const extraUserIds: string[] = [];

  async function makeSession(uid: string): Promise<string> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const refresh = authLib.signRefreshToken(uid, sessionId);
    const hash = createHash("sha256").update(refresh).digest("hex");
    await db.insert(userSessions).values({ id: sessionId, userId: uid, tokenHash: hash, expiresAt });
    return authLib.signAccessToken(uid, sessionId);
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] = process.env["JWT_SECRET"] ?? "labtrax-test-secret-2fa";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    authLib = await import("../lib/auth.js");
    cryptoLib = await import("../lib/crypto.js");

    const { db, users } = dbMod as any;
    await db.insert(users).values({
      id: userId,
      username,
      password: await cryptoLib.hashPassword(password),
      email: `${username}@test.local`,
      isActive: true,
    });
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const { db, auditLogs, userSessions, trustedDevices, users } = dbMod as any;
    const ids = [userId, ...extraUserIds];
    await db.delete(auditLogs).where(inArray(auditLogs.userId, ids));
    await db.delete(trustedDevices).where(inArray(trustedDevices.userId, ids));
    await db.delete(userSessions).where(inArray(userSessions.userId, ids));
    await db.delete(users).where(inArray(users.id, ids));
  });

  it("GET /status defaults to disabled for a fresh account", async () => {
    const access = await makeSession(userId);
    const r = await request(appMod.default)
      .get("/api/auth/2fa/status")
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    expect(r.body.data.twoFactorEnabled).toBeFalsy();
  });

  it("POST /setup requires auth (401 unauthenticated)", async () => {
    const r = await request(appMod.default).post("/api/auth/2fa/setup");
    expect(r.status).toBe(401);
  });

  it("POST /setup returns a TOTP secret, /confirm rejects a wrong code then enables on a valid TOTP", async () => {
    const access = await makeSession(userId);

    const setup = await request(appMod.default)
      .post("/api/auth/2fa/setup")
      .set("Authorization", `Bearer ${access}`);
    expect(setup.status).toBe(200);
    expect(typeof setup.body.data.secret).toBe("string");
    expect(setup.body.data.otpauthUrl).toContain("otpauth");
    secret = setup.body.data.secret;

    // Wrong code → 422, 2FA stays disabled.
    const bad = await request(appMod.default)
      .post("/api/auth/2fa/confirm")
      .set("Authorization", `Bearer ${access}`)
      .send({ code: "000000" });
    expect(bad.status).toBe(422);

    // Valid TOTP → enabled + 8 backup codes.
    const confirm = await request(appMod.default)
      .post("/api/auth/2fa/confirm")
      .set("Authorization", `Bearer ${access}`)
      .send({ code: generateSync({ secret }) });
    expect(confirm.status).toBe(200);
    expect(confirm.body.data.enabled).toBe(true);
    expect(Array.isArray(confirm.body.data.backupCodes)).toBe(true);
    expect(confirm.body.data.backupCodes.length).toBe(8);
    backupCodes = confirm.body.data.backupCodes;

    const status = await request(appMod.default)
      .get("/api/auth/2fa/status")
      .set("Authorization", `Bearer ${access}`);
    expect(status.body.data.twoFactorEnabled).toBe(true);
  });

  it("login with 2FA enabled returns requiresTwoFactor + pendingToken (no session)", async () => {
    const r = await request(appMod.default)
      .post("/api/auth/login")
      .send({ username, password, clientType: "mobile" });
    expect(r.status).toBe(200);
    expect(r.body.requiresTwoFactor).toBe(true);
    expect(typeof r.body.pendingToken).toBe("string");
    // No tokens leak before the second factor is satisfied.
    expect(r.body.accessToken).toBeUndefined();
  });

  it("challenge with an invalid pendingToken returns 401", async () => {
    const r = await request(appMod.default)
      .post("/api/auth/2fa/challenge")
      .send({ pendingToken: "not-a-real-token", code: generateSync({ secret }) });
    expect(r.status).toBe(401);
  });

  it("challenge with a wrong code returns 422", async () => {
    const login = await request(appMod.default)
      .post("/api/auth/login")
      .send({ username, password, clientType: "mobile" });
    const r = await request(appMod.default)
      .post("/api/auth/2fa/challenge")
      .send({ pendingToken: login.body.pendingToken, code: "000000" });
    expect(r.status).toBe(422);
  });

  it("challenge with a valid TOTP issues bearer tokens", async () => {
    const login = await request(appMod.default)
      .post("/api/auth/login")
      .send({ username, password, clientType: "mobile" });
    const r = await request(appMod.default)
      .post("/api/auth/2fa/challenge")
      .send({
        pendingToken: login.body.pendingToken,
        code: generateSync({ secret }),
        clientType: "mobile",
      });
    expect(r.status).toBe(200);
    expect(r.body.data.success).toBe(true);
    expect(typeof r.body.data.accessToken).toBe("string");
    expect(typeof r.body.data.refreshToken).toBe("string");
  });

  it("challenge accepts a single-use backup code", async () => {
    const login = await request(appMod.default)
      .post("/api/auth/login")
      .send({ username, password, clientType: "mobile" });
    const code = backupCodes[0];
    const r = await request(appMod.default)
      .post("/api/auth/2fa/challenge")
      .send({ pendingToken: login.body.pendingToken, code, clientType: "mobile" });
    expect(r.status).toBe(200);
    expect(r.body.data.success).toBe(true);

    // Same backup code cannot be reused.
    const login2 = await request(appMod.default)
      .post("/api/auth/login")
      .send({ username, password, clientType: "mobile" });
    const reuse = await request(appMod.default)
      .post("/api/auth/2fa/challenge")
      .send({ pendingToken: login2.body.pendingToken, code, clientType: "mobile" });
    expect(reuse.status).toBe(422);
  });

  // ---------------------------------------------------------------------
  // Trusted "remember this device" path — security guardrail.
  //
  // The challenge endpoint can issue a device-trust token (trustDevice:true)
  // that lets a returning client skip the second factor on /login. Because
  // this bypasses 2FA, the positive path (a valid token skips the challenge)
  // and the negative paths (missing / forged / expired token still force the
  // challenge) must be locked down so a future change can't silently weaken
  // login security.
  // ---------------------------------------------------------------------

  it("challenge with trustDevice issues a device-trust token", async () => {
    const login = await request(appMod.default)
      .post("/api/auth/login")
      .send({ username, password, clientType: "mobile" });
    const r = await request(appMod.default)
      .post("/api/auth/2fa/challenge")
      .send({
        pendingToken: login.body.pendingToken,
        code: generateSync({ secret }),
        clientType: "mobile",
        trustDevice: true,
        deviceName: "Trusted Test Device",
      });
    expect(r.status).toBe(200);
    expect(r.body.data.success).toBe(true);
    expect(typeof r.body.data.deviceTrustToken).toBe("string");
    expect(r.body.data.deviceTrustToken.length).toBeGreaterThan(0);
    deviceTrustToken = r.body.data.deviceTrustToken;
  });

  it("login with a valid device-trust token skips the 2FA challenge", async () => {
    const r = await request(appMod.default)
      .post("/api/auth/login")
      .send({ username, password, clientType: "mobile", deviceTrustToken });
    expect(r.status).toBe(200);
    // No second factor required — a full session is issued immediately.
    expect(r.body.requiresTwoFactor).toBeFalsy();
    expect(r.body.pendingToken).toBeUndefined();
    expect(typeof r.body.accessToken).toBe("string");
    expect(typeof r.body.refreshToken).toBe("string");
  });

  it("login WITHOUT a device-trust token still forces the 2FA challenge", async () => {
    const r = await request(appMod.default)
      .post("/api/auth/login")
      .send({ username, password, clientType: "mobile" });
    expect(r.status).toBe(200);
    expect(r.body.requiresTwoFactor).toBe(true);
    expect(typeof r.body.pendingToken).toBe("string");
    // No tokens leak before the second factor is satisfied.
    expect(r.body.accessToken).toBeUndefined();
    expect(r.body.refreshToken).toBeUndefined();
  });

  it("login with a forged device-trust token still forces the 2FA challenge", async () => {
    const r = await request(appMod.default)
      .post("/api/auth/login")
      .send({
        username,
        password,
        clientType: "mobile",
        deviceTrustToken: `forged_${randomBytes(24).toString("hex")}`,
      });
    expect(r.status).toBe(200);
    expect(r.body.requiresTwoFactor).toBe(true);
    expect(typeof r.body.pendingToken).toBe("string");
    expect(r.body.accessToken).toBeUndefined();
    expect(r.body.refreshToken).toBeUndefined();
  });

  it("login with an EXPIRED device-trust token still forces the 2FA challenge", async () => {
    const { db, trustedDevices } = dbMod as any;
    // Seed a trusted-device row for this user whose token has already expired.
    const expiredPlain = cryptoLib.randomToken(32);
    await db.insert(trustedDevices).values({
      userId,
      tokenHash: cryptoLib.sha256(expiredPlain),
      deviceName: "Expired Device",
      expiresAt: new Date(Date.now() - 60_000),
    });

    const r = await request(appMod.default)
      .post("/api/auth/login")
      .send({ username, password, clientType: "mobile", deviceTrustToken: expiredPlain });
    expect(r.status).toBe(200);
    expect(r.body.requiresTwoFactor).toBe(true);
    expect(typeof r.body.pendingToken).toBe("string");
    expect(r.body.accessToken).toBeUndefined();
    expect(r.body.refreshToken).toBeUndefined();
  });

  it("disabling 2FA forgets trusted devices so a stale token can't survive a disable/re-enable cycle", async () => {
    const { db, trustedDevices } = dbMod as any;

    // 1. Trust this device via the challenge endpoint.
    const login = await request(appMod.default)
      .post("/api/auth/login")
      .send({ username, password, clientType: "mobile" });
    const challenge = await request(appMod.default)
      .post("/api/auth/2fa/challenge")
      .send({
        pendingToken: login.body.pendingToken,
        code: generateSync({ secret }),
        clientType: "mobile",
        trustDevice: true,
        deviceName: "Soon-to-be-forgotten Device",
      });
    expect(challenge.status).toBe(200);
    const staleToken = challenge.body.data.deviceTrustToken;
    expect(typeof staleToken).toBe("string");

    // Sanity: the freshly-trusted device skips the 2FA challenge.
    const trustedLogin = await request(appMod.default)
      .post("/api/auth/login")
      .send({ username, password, clientType: "mobile", deviceTrustToken: staleToken });
    expect(trustedLogin.body.requiresTwoFactor).toBeFalsy();
    expect(typeof trustedLogin.body.accessToken).toBe("string");

    // There is at least one trusted-device row for this user before the disable.
    const before = await db
      .select()
      .from(trustedDevices)
      .where(eq(trustedDevices.userId, userId));
    expect(before.length).toBeGreaterThan(0);

    // 2. Disable 2FA — this must purge ALL trusted devices.
    const access = await makeSession(userId);
    const disable = await request(appMod.default)
      .delete("/api/auth/2fa")
      .set("Authorization", `Bearer ${access}`)
      .send({ code: generateSync({ secret }) });
    expect(disable.status).toBe(200);

    // 3. No trusted_devices rows remain for this user.
    const after = await db
      .select()
      .from(trustedDevices)
      .where(eq(trustedDevices.userId, userId));
    expect(after.length).toBe(0);

    // 4. Re-enable 2FA with a fresh secret (start a new disable/re-enable cycle).
    const setup = await request(appMod.default)
      .post("/api/auth/2fa/setup")
      .set("Authorization", `Bearer ${access}`);
    expect(setup.status).toBe(200);
    secret = setup.body.data.secret;
    const confirm = await request(appMod.default)
      .post("/api/auth/2fa/confirm")
      .set("Authorization", `Bearer ${access}`)
      .send({ code: generateSync({ secret }) });
    expect(confirm.status).toBe(200);
    backupCodes = confirm.body.data.backupCodes;

    // 5. The stale trust token must NOT survive the cycle — login still
    // forces the 2FA challenge and leaks no session tokens.
    const staleLogin = await request(appMod.default)
      .post("/api/auth/login")
      .send({ username, password, clientType: "mobile", deviceTrustToken: staleToken });
    expect(staleLogin.body.requiresTwoFactor).toBe(true);
    expect(typeof staleLogin.body.pendingToken).toBe("string");
    expect(staleLogin.body.accessToken).toBeUndefined();
    expect(staleLogin.body.refreshToken).toBeUndefined();
  });

  // ---------------------------------------------------------------------
  // Password reset (account recovery) — security guardrail.
  //
  // Resetting a forgotten password is exactly the moment all prior device
  // trust should be invalidated: if an attacker had marked a device
  // "remember me", that device's trust token must NOT keep skipping the
  // 2FA challenge after the owner resets the password to lock the attacker
  // out. This mirrors the disable-2FA purge above.
  // ---------------------------------------------------------------------

  it("resetting a forgotten password forgets trusted devices so a stale token can't skip the 2FA challenge", async () => {
    const { db, users: usersTable, trustedDevices } = dbMod as any;
    const { encryptTotpSecret } = await import("../lib/totp-encryption.js");

    // Dedicated 2FA-enabled user so we can safely rotate its password without
    // disturbing the ordered tests that reuse the shared account.
    const rUserId = rid("urst");
    const rUsername = `rst_${randomBytes(3).toString("hex")}`;
    const rEmail = `${rUsername}@test.local`;
    const rPassword = "ResetPass1!";
    const rSecret = generateSecret();
    extraUserIds.push(rUserId);

    await db.insert(usersTable).values({
      id: rUserId,
      username: rUsername,
      password: await cryptoLib.hashPassword(rPassword),
      email: rEmail,
      isActive: true,
      twoFactorEnabled: true,
      twoFactorSecret: encryptTotpSecret(rSecret),
    });

    // 1. Trust this device via the challenge endpoint.
    const login = await request(appMod.default)
      .post("/api/auth/login")
      .send({ username: rUsername, password: rPassword, clientType: "mobile" });
    expect(login.body.requiresTwoFactor).toBe(true);
    const challenge = await request(appMod.default)
      .post("/api/auth/2fa/challenge")
      .send({
        pendingToken: login.body.pendingToken,
        code: generateSync({ secret: rSecret }),
        clientType: "mobile",
        trustDevice: true,
        deviceName: "Pre-reset Device",
      });
    expect(challenge.status).toBe(200);
    const staleToken = challenge.body.data.deviceTrustToken;
    expect(typeof staleToken).toBe("string");

    // Sanity: the freshly-trusted device skips the 2FA challenge.
    const trustedLogin = await request(appMod.default)
      .post("/api/auth/login")
      .send({ username: rUsername, password: rPassword, clientType: "mobile", deviceTrustToken: staleToken });
    expect(trustedLogin.body.requiresTwoFactor).toBeFalsy();
    expect(typeof trustedLogin.body.accessToken).toBe("string");

    // There is at least one trusted-device row before the reset.
    const before = await db
      .select()
      .from(trustedDevices)
      .where(eq(trustedDevices.userId, rUserId));
    expect(before.length).toBeGreaterThan(0);

    // 2. Run the forgot-password → reset-password flow. The reset token is
    //    only surfaced via demoResetLink in development with SMTP unset.
    const prevNodeEnv = process.env["NODE_ENV"];
    const prevSmtpHost = process.env["SMTP_HOST"];
    const prevSmtpUser = process.env["SMTP_USER"];
    const prevSmtpPass = process.env["SMTP_PASS"];
    process.env["NODE_ENV"] = "development";
    delete process.env["SMTP_HOST"];
    delete process.env["SMTP_USER"];
    delete process.env["SMTP_PASS"];

    let resetToken: string | undefined;
    try {
      const forgot = await request(appMod.default)
        .post("/api/forgot-password")
        .send({ email: rEmail });
      expect(forgot.status).toBe(200);
      expect(typeof forgot.body.demoResetLink).toBe("string");
      resetToken = new URL(forgot.body.demoResetLink).searchParams.get("token") ?? undefined;
      expect(typeof resetToken).toBe("string");

      const reset = await request(appMod.default)
        .post("/api/reset-password")
        .send({ token: resetToken, newPassword: "NewResetPass2!" });
      expect(reset.status).toBe(200);
      expect(reset.body.success).toBe(true);
    } finally {
      if (prevNodeEnv === undefined) delete process.env["NODE_ENV"]; else process.env["NODE_ENV"] = prevNodeEnv;
      if (prevSmtpHost === undefined) delete process.env["SMTP_HOST"]; else process.env["SMTP_HOST"] = prevSmtpHost;
      if (prevSmtpUser === undefined) delete process.env["SMTP_USER"]; else process.env["SMTP_USER"] = prevSmtpUser;
      if (prevSmtpPass === undefined) delete process.env["SMTP_PASS"]; else process.env["SMTP_PASS"] = prevSmtpPass;
    }

    // 3. All trusted_devices rows for the user are gone after the reset.
    const after = await db
      .select()
      .from(trustedDevices)
      .where(eq(trustedDevices.userId, rUserId));
    expect(after.length).toBe(0);

    // 4. The pre-reset trust token must NOT survive — login with the new
    //    password still forces the 2FA challenge and leaks no session tokens.
    const staleLogin = await request(appMod.default)
      .post("/api/auth/login")
      .send({ username: rUsername, password: "NewResetPass2!", clientType: "mobile", deviceTrustToken: staleToken });
    expect(staleLogin.body.requiresTwoFactor).toBe(true);
    expect(typeof staleLogin.body.pendingToken).toBe("string");
    expect(staleLogin.body.accessToken).toBeUndefined();
    expect(staleLogin.body.refreshToken).toBeUndefined();
  });

  it("DELETE / disables 2FA on a valid TOTP and login no longer challenges", async () => {
    const access = await makeSession(userId);
    const r = await request(appMod.default)
      .delete("/api/auth/2fa")
      .set("Authorization", `Bearer ${access}`)
      .send({ code: generateSync({ secret }) });
    expect(r.status).toBe(200);
    expect(r.body.data.success).toBe(true);

    const status = await request(appMod.default)
      .get("/api/auth/2fa/status")
      .set("Authorization", `Bearer ${access}`);
    expect(status.body.data.twoFactorEnabled).toBeFalsy();

    const login = await request(appMod.default)
      .post("/api/auth/login")
      .send({ username, password, clientType: "mobile" });
    expect(login.status).toBe(200);
    expect(login.body.requiresTwoFactor).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// Remembered-devices "sign out" management — list + revoke.
//
// The Settings UI on desktop and mobile lists a user's remembered (trusted)
// devices and lets them sign one out. These are the API guarantees that UI
// depends on, and the security guarantees that keep one user from touching
// another user's devices:
//   - GET /api/auth/2fa/trusted-devices returns ONLY the caller's own
//     non-expired devices (no cross-user leakage, expired rows hidden).
//   - DELETE /api/auth/2fa/trusted-devices/:id revokes the caller's own
//     device, and returns 404 (without deleting) for an id that belongs to
//     another user — so a stolen/guessed id can't sign out someone else.
//   - Both endpoints require authentication.
// ---------------------------------------------------------------------------

maybe("Remembered devices — list & revoke (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let authLib: typeof import("../lib/auth.js");
  let cryptoLib: typeof import("../lib/crypto.js");

  const userAId = rid("u2fa_a");
  const userBId = rid("u2fa_b");

  async function makeSession(uid: string): Promise<string> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const refresh = authLib.signRefreshToken(uid, sessionId);
    const hash = createHash("sha256").update(refresh).digest("hex");
    await db.insert(userSessions).values({ id: sessionId, userId: uid, tokenHash: hash, expiresAt });
    return authLib.signAccessToken(uid, sessionId);
  }

  async function seedDevice(
    uid: string,
    opts: { deviceName: string; expiresAt: Date },
  ): Promise<string> {
    const { db, trustedDevices } = dbMod as any;
    const [row] = await db
      .insert(trustedDevices)
      .values({
        userId: uid,
        tokenHash: cryptoLib.sha256(cryptoLib.randomToken(32)),
        deviceName: opts.deviceName,
        expiresAt: opts.expiresAt,
      })
      .returning({ id: trustedDevices.id });
    return row.id as string;
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] = process.env["JWT_SECRET"] ?? "labtrax-test-secret-2fa";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    authLib = await import("../lib/auth.js");
    cryptoLib = await import("../lib/crypto.js");

    const { db, users } = dbMod as any;
    for (const uid of [userAId, userBId]) {
      await db.insert(users).values({
        id: uid,
        username: `tfa_dev_${randomBytes(3).toString("hex")}`,
        password: await cryptoLib.hashPassword("TestPass1!"),
        email: `${uid}@test.local`,
        isActive: true,
      });
    }
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const { db, auditLogs, userSessions, trustedDevices, users } = dbMod as any;
    const ids = [userAId, userBId];
    await db.delete(auditLogs).where(inArray(auditLogs.userId, ids));
    await db.delete(trustedDevices).where(inArray(trustedDevices.userId, ids));
    await db.delete(userSessions).where(inArray(userSessions.userId, ids));
    await db.delete(users).where(inArray(users.id, ids));
  });

  const future = () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const past = () => new Date(Date.now() - 60_000);

  it("GET /trusted-devices requires auth (401 unauthenticated)", async () => {
    const r = await request(appMod.default).get("/api/auth/2fa/trusted-devices");
    expect(r.status).toBe(401);
  });

  it("DELETE /trusted-devices/:id requires auth (401 unauthenticated)", async () => {
    const r = await request(appMod.default).delete("/api/auth/2fa/trusted-devices/anything");
    expect(r.status).toBe(401);
  });

  it("GET /trusted-devices returns only the caller's non-expired devices", async () => {
    const activeA1 = await seedDevice(userAId, { deviceName: "A laptop", expiresAt: future() });
    const activeA2 = await seedDevice(userAId, { deviceName: "A phone", expiresAt: future() });
    const expiredA = await seedDevice(userAId, { deviceName: "A old", expiresAt: past() });
    const activeB = await seedDevice(userBId, { deviceName: "B phone", expiresAt: future() });

    const access = await makeSession(userAId);
    const r = await request(appMod.default)
      .get("/api/auth/2fa/trusted-devices")
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);

    const devices = r.body.data.devices as Array<{ id: string }>;
    const ids = devices.map((d) => d.id);
    // Both of A's active devices are present.
    expect(ids).toContain(activeA1);
    expect(ids).toContain(activeA2);
    // A's expired device is hidden, and B's device never leaks to A.
    expect(ids).not.toContain(expiredA);
    expect(ids).not.toContain(activeB);
    // Exactly the two active rows for A.
    expect(ids).toHaveLength(2);
  });

  it("DELETE /trusted-devices/:id revokes the caller's own device", async () => {
    const deviceId = await seedDevice(userAId, { deviceName: "A tablet", expiresAt: future() });

    const access = await makeSession(userAId);
    const del = await request(appMod.default)
      .delete(`/api/auth/2fa/trusted-devices/${deviceId}`)
      .set("Authorization", `Bearer ${access}`);
    expect(del.status).toBe(200);
    expect(del.body.data.success).toBe(true);

    // It no longer appears in the caller's list.
    const list = await request(appMod.default)
      .get("/api/auth/2fa/trusted-devices")
      .set("Authorization", `Bearer ${access}`);
    const ids = (list.body.data.devices as Array<{ id: string }>).map((d) => d.id);
    expect(ids).not.toContain(deviceId);

    // And the row is actually gone from the DB.
    const { db, trustedDevices } = dbMod as any;
    const remaining = await db
      .select({ id: trustedDevices.id })
      .from(trustedDevices)
      .where(eq(trustedDevices.id, deviceId));
    expect(remaining).toHaveLength(0);
  });

  it("DELETE /trusted-devices/:id returns 404 for another user's device and leaves it intact", async () => {
    const bDeviceId = await seedDevice(userBId, { deviceName: "B laptop", expiresAt: future() });

    const accessA = await makeSession(userAId);
    const del = await request(appMod.default)
      .delete(`/api/auth/2fa/trusted-devices/${bDeviceId}`)
      .set("Authorization", `Bearer ${accessA}`);
    expect(del.status).toBe(404);

    // B's device must still exist — A cannot sign out B's device.
    const { db, trustedDevices } = dbMod as any;
    const remaining = await db
      .select({ id: trustedDevices.id })
      .from(trustedDevices)
      .where(eq(trustedDevices.id, bDeviceId));
    expect(remaining).toHaveLength(1);
  });
});
