/**
 * Regression guard: PUT /api/auth/users/:id/profile clears phoneVerifiedAt
 * when the submitted phone number differs from the currently stored one.
 *
 * Skipped when DATABASE_URL is not configured. All inserted rows are removed
 * in afterAll so the suite is safe to run against a shared dev DB.
 *
 * Coverage:
 *  - Changing phone number → phoneVerifiedAt is cleared (null)
 *  - Re-submitting the same phone → phoneVerifiedAt is preserved
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
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
  caseMediaDir: path.join(require("os").tmpdir(), "labtrax-test-media-phone-clear"),
  extractMediaFileName: () => null,
}));

vi.setConfig({ testTimeout: 60000, hookTimeout: 90000 });

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("Profile update — phone change clears phoneVerifiedAt (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let authLib: typeof import("../lib/auth.js");

  const userId = rid("uphoneclr");
  const username = `phclr_${randomBytes(3).toString("hex")}`;
  const email = `${username}@test.local`;
  const originalPhone = "5550001111";
  const verifiedAt = new Date("2025-01-15T10:00:00Z");

  async function makeAccess(uid: string): Promise<string> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const refresh = authLib.signRefreshToken(uid, sessionId);
    const hash = createHash("sha256").update(refresh).digest("hex");
    await db.insert(userSessions).values({ id: sessionId, userId: uid, tokenHash: hash, expiresAt });
    return authLib.signAccessToken(uid, sessionId);
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] = process.env["JWT_SECRET"] ?? "labtrax-test-secret-phone-clear";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    authLib = await import("../lib/auth.js");

    const { db, users } = dbMod as any;
    await db.insert(users).values({
      id: userId,
      username,
      password: "doesnotmatter",
      email,
      phone: originalPhone,
      phoneVerifiedAt: verifiedAt,
    });
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const { db, auditLogs, userSessions, users } = dbMod as any;
    await db.delete(auditLogs).where(inArray(auditLogs.userId, [userId]));
    await db.delete(userSessions).where(eq(userSessions.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("re-submitting the same phone preserves phoneVerifiedAt", async () => {
    const access = await makeAccess(userId);

    const r = await request(appMod.default)
      .put(`/api/auth/users/${userId}/profile`)
      .set("Authorization", `Bearer ${access}`)
      .send({ phone: originalPhone });

    expect(r.status).toBe(200);

    const { db, users } = dbMod as any;
    const [u] = await db.select().from(users).where(eq(users.id, userId));
    expect(u.phoneVerifiedAt).not.toBeNull();
    expect(new Date(u.phoneVerifiedAt).toISOString()).toBe(verifiedAt.toISOString());
  });

  it("changing the phone number clears phoneVerifiedAt", async () => {
    const access = await makeAccess(userId);
    const newPhone = "5559998888";

    const r = await request(appMod.default)
      .put(`/api/auth/users/${userId}/profile`)
      .set("Authorization", `Bearer ${access}`)
      .send({ phone: newPhone });

    expect(r.status).toBe(200);

    const { db, users } = dbMod as any;
    const [u] = await db.select().from(users).where(eq(users.id, userId));
    expect(u.phone).toBe(newPhone);
    expect(u.phoneVerifiedAt).toBeNull();

    const me = await request(appMod.default)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${access}`);
    expect(me.status).toBe(200);
    expect(me.body.user.phoneVerifiedAt).toBeNull();
  });
});
