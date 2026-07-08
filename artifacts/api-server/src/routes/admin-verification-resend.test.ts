/**
 * Admin verification email resend — regression guard.
 *
 * POST /admin/users/:id/send-verification-email
 * - Gated by platform-admin secret
 * - Only works for unverified users with an email
 * - Generates a 6-digit code and persists it to verification_codes
 * - Skipped when DATABASE_URL is not set.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, createHash } from "node:crypto";
import request from "supertest";
import * as path from "node:path";
import { inArray } from "drizzle-orm";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(require("os").tmpdir(), "labtrax-test-media-verify-resend"),
  extractMediaFileName: () => null,
}));

vi.mock("../lib/mail.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/mail.js")>("../lib/mail.js");
  return {
    ...actual,
    sendMail: vi.fn().mockResolvedValue({ sent: true }),
    sendInstallerPublishFailureAlertEmail: vi.fn().mockResolvedValue(undefined),
  };
});

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

const PLATFORM_ADMIN_SECRET = "verify-resend-test-secret";
process.env["PLATFORM_ADMIN_SECRET"] = PLATFORM_ADMIN_SECRET;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("Admin verification email resend", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let authLib: typeof import("../lib/auth.js");

  const createdUserIds: string[] = [];

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
    process.env["JWT_SECRET"] = process.env["JWT_SECRET"] ?? "labtrax-test-secret-verify-resend";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    authLib = await import("../lib/auth.js");
  });

  beforeEach(async () => {
    // Clean any prior verification codes for the test email targets
    const { db, verificationCodes } = dbMod as any;
    if (createdUserIds.length > 0) {
      await db
        .delete(verificationCodes)
        .where(inArray((dbMod as any).verificationCodes.userId, createdUserIds));
    }
  });

  afterAll(async () => {
    if (!SHOULD_RUN || createdUserIds.length === 0) return;
    const { db, auditLogs, userSessions, verificationCodes, users } = dbMod as any;
    await db.delete(auditLogs).where(inArray(auditLogs.userId, createdUserIds));
    await db.delete(userSessions).where(inArray(userSessions.userId, createdUserIds));
    await db.delete(verificationCodes).where(inArray(verificationCodes.userId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
  });

  it("rejects without admin credentials (401)", async () => {
    const res = await request(appMod.default)
      .post("/api/admin/users/some-id/send-verification-email");
    expect(res.status).toBe(401);
  });

  it("rejects with wrong admin secret (401 via requireAuth)", async () => {
    const res = await request(appMod.default)
      .post("/api/admin/users/some-id/send-verification-email")
      .set("x-platform-admin-secret", "wrong-secret");
    expect(res.status).toBe(401);
  });

  it("returns 404 for a non-existent user", async () => {
    const res = await request(appMod.default)
      .post("/api/admin/users/nonexistent-uuid/send-verification-email")
      .set("x-platform-admin-secret", PLATFORM_ADMIN_SECRET);
    expect(res.status).toBe(404);
    expect(res.body.error).toContain("not found");
  });

  it("returns 400 when user has no email", async () => {
    const userId = rid("u");
    const { db, users } = dbMod as any;
    await db.insert(users).values({
      id: userId,
      username: `nemail_${userId}`,
      password: "doesnotmatter",
      email: null,
    });
    createdUserIds.push(userId);

    const res = await request(appMod.default)
      .post(`/api/admin/users/${userId}/send-verification-email`)
      .set("x-platform-admin-secret", PLATFORM_ADMIN_SECRET);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("no email");
  });

  it("returns 400 when email is already verified", async () => {
    const userId = rid("u");
    const { db, users } = dbMod as any;
    await db.insert(users).values({
      id: userId,
      username: `verif_${userId}`,
      password: "doesnotmatter",
      email: `verif_${userId}@example.com`,
      emailVerifiedAt: new Date(),
    });
    createdUserIds.push(userId);

    const res = await request(appMod.default)
      .post(`/api/admin/users/${userId}/send-verification-email`)
      .set("x-platform-admin-secret", PLATFORM_ADMIN_SECRET);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("already verified");
  });

  it("sends a verification code to an unverified user and persists it", async () => {
    const userId = rid("u");
    const email = `unver_${userId}@example.com`;
    const { db, users, verificationCodes } = dbMod as any;
    await db.insert(users).values({
      id: userId,
      username: `unver_${userId}`,
      password: "doesnotmatter",
      email,
      emailVerifiedAt: null,
    });
    createdUserIds.push(userId);

    const res = await request(appMod.default)
      .post(`/api/admin/users/${userId}/send-verification-email`)
      .set("x-platform-admin-secret", PLATFORM_ADMIN_SECRET);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Verify the code was persisted
    const rows = await db
      .select()
      .from(verificationCodes)
      .where(inArray(verificationCodes.userId, [userId]));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const latest = rows.sort((a: any, b: any) => b.createdAt - a.createdAt)[0];
    expect(latest.channel).toBe("email");
    expect(latest.target).toBe(email.toLowerCase().trim());
    expect(latest.consumedAt).toBeNull();
    expect(latest.expiresAt.getTime()).toBeGreaterThan(Date.now());
  }, 15000);

  it("GET /admin/users now includes emailVerifiedAt", async () => {
    const userId = rid("u");
    const { db, users } = dbMod as any;
    const verifiedAt = new Date("2026-01-15T12:00:00Z");
    await db.insert(users).values({
      id: userId,
      username: `list_${userId}`,
      password: "doesnotmatter",
      email: `list_${userId}@example.com`,
      emailVerifiedAt: verifiedAt,
    });
    createdUserIds.push(userId);

    const res = await request(appMod.default)
      .get("/api/admin/users")
      .set("x-platform-admin-secret", PLATFORM_ADMIN_SECRET);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const found = res.body.users.find((u: any) => u.id === userId);
    expect(found).toBeDefined();
    expect(found.emailVerifiedAt).toBe(verifiedAt.toISOString());
  });
});
