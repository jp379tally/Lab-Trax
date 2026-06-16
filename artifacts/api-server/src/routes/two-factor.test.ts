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
import { generateSync } from "otplib";
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
vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

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
    await db.delete(auditLogs).where(inArray(auditLogs.userId, [userId]));
    await db.delete(trustedDevices).where(eq(trustedDevices.userId, userId));
    await db.delete(userSessions).where(eq(userSessions.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
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
