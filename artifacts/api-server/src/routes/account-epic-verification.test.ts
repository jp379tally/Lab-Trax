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
vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

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
});
