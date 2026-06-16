/**
 * DB-backed behavioural tests for the email / phone verification-code workflow
 * — Account epic Phase 6 regression guard.
 *
 * Skipped when DATABASE_URL is not configured. All inserted rows are removed
 * in afterAll so the suite is safe to run against a shared dev DB.
 *
 * The send endpoints only echo the demo code in NODE_ENV=development, so these
 * tests seed a known code through the same `createVerificationCode` helper the
 * routes use and then exercise the real verify endpoints end-to-end.
 *
 * Coverage (Protected Workflows: Email Verification / Phone Verification):
 *  - POST /api/send-email-code | /api/send-phone-code — 400 without a target,
 *    200 with one.
 *  - POST /api/verify-email-code — wrong code → { verified: false };
 *    correct code → { verified: true } + sets users.emailVerifiedAt + audit.
 *  - POST /api/verify-phone-code — correct code → { verified: true } + sets
 *    users.phoneVerifiedAt + audit.
 *  - A consumed (single-use) code cannot be replayed.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import request from "supertest";
import * as path from "node:path";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(require("os").tmpdir(), "labtrax-test-media-verify"),
  extractMediaFileName: () => null,
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

// DB-integration tests that hit send/verify endpoints (the send path may do a
// real email/SMS attempt with MX-lookup latency). Under full-suite contention
// the default 5s budget is too tight, so give these headroom to avoid flakes.
// Per-file timeouts must stay at or above the global hookTimeout (90 s) so
// two concurrent test workflows (api-server-tests + regression-tests) can
// both wait out DB-pool contention without timing out.
vi.setConfig({ testTimeout: 60000, hookTimeout: 90000 });

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("Account epic — email/phone verification (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let authLib: typeof import("../lib/auth.js");
  let verifyLib: typeof import("../lib/verification.js");

  const userId = rid("uverify");
  const username = `vfy_${randomBytes(3).toString("hex")}`;
  const email = `${username}@test.local`;
  const phone = "5551230099";

  // Extra verification-code targets created by the throttle tests; cleaned up
  // in afterAll alongside the primary email/phone targets.
  const throttleTargets: string[] = [];

  async function codeCountForTarget(target: string): Promise<number> {
    const { db, verificationCodes } = dbMod as any;
    const rows = await db
      .select()
      .from(verificationCodes)
      .where(eq(verificationCodes.target, target));
    return rows.length;
  }

  async function makeAccess(uid: string): Promise<string> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const refresh = authLib.signRefreshToken(uid, sessionId);
    const hash = createHash("sha256").update(refresh).digest("hex");
    await db.insert(userSessions).values({ id: sessionId, userId: uid, tokenHash: hash, expiresAt });
    return authLib.signAccessToken(uid, sessionId);
  }

  async function latestAudit(action: string): Promise<unknown | undefined> {
    const { db, auditLogs } = dbMod as any;
    const [row] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.userId, userId), eq(auditLogs.action, action)))
      .orderBy(desc(auditLogs.createdAt))
      .limit(1);
    return row;
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] = process.env["JWT_SECRET"] ?? "labtrax-test-secret-verify";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    authLib = await import("../lib/auth.js");
    verifyLib = await import("../lib/verification.js");

    const { db, users } = dbMod as any;
    await db.insert(users).values({
      id: userId,
      username,
      password: "doesnotmatter",
      email,
      phone,
    });
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const { db, auditLogs, userSessions, verificationCodes, users } = dbMod as any;
    await db.delete(auditLogs).where(inArray(auditLogs.userId, [userId]));
    await db.delete(userSessions).where(eq(userSessions.userId, userId));
    await db
      .delete(verificationCodes)
      .where(
        inArray(verificationCodes.target, [
          verifyLib.normalizeEmailTarget(email),
          verifyLib.normalizePhoneTarget(phone),
          ...throttleTargets,
        ])
      );
    await db.delete(users).where(eq(users.id, userId));
  });

  // ── Send endpoints ──────────────────────────────────────────────────────

  it("POST /send-email-code rejects a missing email (400) and accepts a valid one (200)", async () => {
    const bad = await request(appMod.default).post("/api/send-email-code").send({});
    expect(bad.status).toBe(400);

    const ok = await request(appMod.default)
      .post("/api/send-email-code")
      .send({ email });
    expect(ok.status).toBe(200);
    expect(ok.body.success).toBe(true);
  });

  it("POST /send-phone-code rejects a missing phone (400) and accepts a valid one (200)", async () => {
    const bad = await request(appMod.default).post("/api/send-phone-code").send({});
    expect(bad.status).toBe(400);

    const ok = await request(appMod.default)
      .post("/api/send-phone-code")
      .send({ phone });
    expect(ok.status).toBe(200);
    expect(ok.body.success).toBe(true);
  });

  // ── Verify email ────────────────────────────────────────────────────────

  it("verify-email-code rejects a wrong code, then verifies the right one and stamps emailVerifiedAt + audit", async () => {
    const code = "654321";
    await verifyLib.createVerificationCode({
      channel: "email",
      target: verifyLib.normalizeEmailTarget(email),
      code,
      userId,
    });

    const wrong = await request(appMod.default)
      .post("/api/verify-email-code")
      .send({ email, code: "111111" });
    expect(wrong.status).toBe(200);
    expect(wrong.body.verified).toBe(false);

    const access = await makeAccess(userId);
    const right = await request(appMod.default)
      .post("/api/verify-email-code")
      .set("Authorization", `Bearer ${access}`)
      .send({ email, code });
    expect(right.status).toBe(200);
    expect(right.body.verified).toBe(true);

    const { db, users } = dbMod as any;
    const [u] = await db.select().from(users).where(eq(users.id, userId));
    expect(u.emailVerifiedAt).toBeTruthy();
    expect(await latestAudit("email_verified")).toBeTruthy();

    // Single-use: the same code cannot be replayed.
    const replay = await request(appMod.default)
      .post("/api/verify-email-code")
      .send({ email, code });
    expect(replay.body.verified).toBe(false);
  });

  // ── Verify phone ────────────────────────────────────────────────────────

  it("verify-phone-code verifies a valid code and stamps phoneVerifiedAt + audit", async () => {
    const code = "246802";
    await verifyLib.createVerificationCode({
      channel: "sms",
      target: verifyLib.normalizePhoneTarget(phone),
      code,
      userId,
    });

    const access = await makeAccess(userId);
    const r = await request(appMod.default)
      .post("/api/verify-phone-code")
      .set("Authorization", `Bearer ${access}`)
      .send({ phone, code });
    expect(r.status).toBe(200);
    expect(r.body.verified).toBe(true);

    const { db, users } = dbMod as any;
    const [u] = await db.select().from(users).where(eq(users.id, userId));
    expect(u.phoneVerifiedAt).toBeTruthy();
    expect(await latestAudit("phone_verified")).toBeTruthy();
  });

  // ── Abuse control (rate limit / cooldown) ───────────────────────────────
  // These guard the denial-of-service / cost-abuse surface flagged in the
  // threat model: an attacker hammering the send endpoints to run up email/SMS
  // bills and spam a victim. A throttled request must return 429 BEFORE the
  // handler dispatches a message — proven here by asserting no new
  // verification_codes row is written for the throttled request.

  it("send-email-code: a rapid resend for the same email is rejected with 429 and dispatches no code", async () => {
    const target = verifyLib.normalizeEmailTarget(`cooldown_${randomBytes(4).toString("hex")}@test.local`);
    throttleTargets.push(target);
    // Unique source IP isolates this test's per-IP bucket from other requests.
    const ip = "203.0.113.10";

    const first = await request(appMod.default)
      .post("/api/send-email-code")
      .set("X-Forwarded-For", ip)
      .send({ email: target });
    expect(first.status).toBe(200);
    expect(await codeCountForTarget(target)).toBe(1);

    const second = await request(appMod.default)
      .post("/api/send-email-code")
      .set("X-Forwarded-For", ip)
      .send({ email: target });
    expect(second.status).toBe(429);
    expect(second.headers["retry-after"]).toBeTruthy();
    // Downstream not invoked: no second code was created for this target.
    expect(await codeCountForTarget(target)).toBe(1);
  });

  it("send-phone-code: a rapid resend for the same phone is rejected with 429 and dispatches no code", async () => {
    const rawPhone = `555${Math.floor(1000000 + Math.random() * 8999999)}`;
    const target = verifyLib.normalizePhoneTarget(rawPhone);
    throttleTargets.push(target);
    const ip = "203.0.113.11";

    const first = await request(appMod.default)
      .post("/api/send-phone-code")
      .set("X-Forwarded-For", ip)
      .send({ phone: rawPhone });
    expect(first.status).toBe(200);
    expect(await codeCountForTarget(target)).toBe(1);

    const second = await request(appMod.default)
      .post("/api/send-phone-code")
      .set("X-Forwarded-For", ip)
      .send({ phone: rawPhone });
    expect(second.status).toBe(429);
    expect(second.headers["retry-after"]).toBeTruthy();
    expect(await codeCountForTarget(target)).toBe(1);
  });

  it("send-email-code: a single source IP is throttled after the per-IP cap, blocking further sends", async () => {
    // Distinct emails avoid the per-identifier cooldown so the per-IP window is
    // the gate under test. maxPerIp is 10 → the 11th request from this IP 429s.
    const ip = "203.0.113.20";
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const target = verifyLib.normalizeEmailTarget(
        `ipcap_${i}_${randomBytes(3).toString("hex")}@test.local`
      );
      throttleTargets.push(target);
      const r = await request(appMod.default)
        .post("/api/send-email-code")
        .set("X-Forwarded-For", ip)
        .send({ email: target });
      statuses.push(r.status);
    }
    // First 10 allowed, 11th throttled.
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it("send-email-code: a missing email still returns the handler's 400 (throttle does not mask validation)", async () => {
    const bad = await request(appMod.default)
      .post("/api/send-email-code")
      .set("X-Forwarded-For", "203.0.113.30")
      .send({});
    expect(bad.status).toBe(400);
  });
});
