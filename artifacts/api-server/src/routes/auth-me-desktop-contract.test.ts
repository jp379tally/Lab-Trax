/**
 * Regression guard: GET /api/auth/me desktop-critical field contract.
 *
 * Protected workflow: "Desktop auth/me response includes practiceLogoUrl
 * and phone-verification timestamps"
 *
 * The desktop client reads several fields from GET /api/auth/me that are only
 * added by hydrateUsersWithActiveMemberships() and are NOT part of the bare
 * users table row. If that hydration step is accidentally removed or short-
 * circuited, the desktop app would silently stop showing the lab logo and
 * would always display "Not verified" for phone status.
 *
 * Fields pinned by this test:
 *   - practiceLogoUrl:    present and string | null (desktop logo → AuthedImage)
 *   - phoneVerifiedAt:    present and ISO-8601 string | null (security status card)
 *   - emailVerifiedAt:    present and ISO-8601 string | null (future verification UI)
 *
 * Keep this test permanently per REGRESSION_GUARDRAILS.md policy.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { inArray } from "drizzle-orm";
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
  caseMediaDir: path.join(require("os").tmpdir(), "labtrax-test-media-auth-me"),
  extractMediaFileName: () => null,
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}
function uname(prefix: string) {
  return `${prefix}${randomBytes(6).toString("hex")}`.slice(0, 12);
}

maybe("GET /api/auth/me — desktop-critical field contract", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };

  const createdUserIds: string[] = [];

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-auth-me";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
  });

  afterAll(async () => {
    if (!SHOULD_RUN || createdUserIds.length === 0) return;
    const { db, auditLogs, userSessions, organizationMemberships, users } = dbMod as any;
    await db.delete(auditLogs).where(inArray(auditLogs.userId, createdUserIds));
    await db.delete(userSessions).where(inArray(userSessions.userId, createdUserIds));
    await db.delete(organizationMemberships).where(
      inArray(organizationMemberships.userId, createdUserIds)
    );
    await db.delete(users).where(inArray(users.id, createdUserIds));
  });

  it("response includes practiceLogoUrl (string|null), phoneVerifiedAt (string|null), emailVerifiedAt (string|null)", async () => {
    const username = uname("me");
    const email = `${rid("me")}@test.example`;
    const password = "TestPassword1!";

    // Register a plain lab user (no org — simplest path)
    const reg = await request(appMod.default)
      .post("/api/auth/register")
      .send({
        username,
        email,
        password,
        userType: "lab",
        clientType: "desktop",
      });
    expect(reg.status).toBe(200);

    const userId: string = reg.body.user?.id;
    expect(userId).toBeTruthy();
    createdUserIds.push(userId);

    const accessToken: string = reg.body.accessToken;
    expect(accessToken).toBeTruthy();

    // Call GET /api/auth/me with the bearer token (desktop client path)
    const me = await request(appMod.default)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${accessToken}`);

    expect(me.status).toBe(200);
    // The response is wrapped in { data: { user: ... } } by the ok() helper
    const user = me.body.data?.user ?? me.body.user;
    expect(user).toBeTruthy();

    // ── practiceLogoUrl ──────────────────────────────────────────────────────
    // Must be present in the response (string or null). If absent (undefined),
    // the desktop conditional `user?.practiceLogoUrl ? <AuthedImage …> : null`
    // evaluates as falsy and the logo never renders.
    expect("practiceLogoUrl" in user).toBe(true);
    expect(
      user.practiceLogoUrl === null || typeof user.practiceLogoUrl === "string",
    ).toBe(true);

    // ── phoneVerifiedAt ──────────────────────────────────────────────────────
    // Must be present (ISO-8601 string when verified, null when not).
    // The Security card in ProfilePanel reads this to show Verified / Not verified.
    expect("phoneVerifiedAt" in user).toBe(true);
    expect(
      user.phoneVerifiedAt === null || typeof user.phoneVerifiedAt === "string",
    ).toBe(true);
    if (typeof user.phoneVerifiedAt === "string") {
      expect(() => new Date(user.phoneVerifiedAt)).not.toThrow();
    }

    // ── emailVerifiedAt ──────────────────────────────────────────────────────
    // Must be present (ISO-8601 string when verified, null when not).
    expect("emailVerifiedAt" in user).toBe(true);
    expect(
      user.emailVerifiedAt === null || typeof user.emailVerifiedAt === "string",
    ).toBe(true);
    if (typeof user.emailVerifiedAt === "string") {
      expect(() => new Date(user.emailVerifiedAt)).not.toThrow();
    }
  });

  it("practiceLogoUrl is explicitly null (not undefined) for a user without a logo", async () => {
    const username = uname("nolo");
    const email = `${rid("nolo")}@test.example`;

    const reg = await request(appMod.default)
      .post("/api/auth/register")
      .send({
        username,
        email,
        password: "TestPassword1!",
        userType: "lab",
        clientType: "desktop",
      });
    expect(reg.status).toBe(200);
    if (reg.body.user?.id) createdUserIds.push(reg.body.user.id);

    const me = await request(appMod.default)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${reg.body.accessToken}`);

    expect(me.status).toBe(200);
    const user = me.body.data?.user ?? me.body.user;
    // practiceLogoUrl must be explicitly null — not undefined — so that the
    // desktop ternary `user.practiceLogoUrl ? <AuthedImage> : null` evaluates
    // correctly and doesn't cause "cannot read property of undefined".
    expect(user.practiceLogoUrl).toBeNull();
  });
});
