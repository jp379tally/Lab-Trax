/**
 * Bearer-auth smoke tests — cookie-jar isolation and 401→refresh→retry.
 *
 * Skipped when DATABASE_URL is not set.  Created rows are removed in afterAll.
 *
 * Coverage:
 *  - Mobile login returns no Set-Cookie header (no cookie-jar CSRF trap).
 *  - Mobile refresh returns no Set-Cookie header.
 *  - 401 response → POST /auth/refresh → new access token → protected request succeeds (retry cycle).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { inArray } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";
import request from "supertest";
import * as path from "node:path";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(
    require("os").tmpdir(),
    "labtrax-test-media-auth-bearer-smoke",
  ),
  extractMediaFileName: () => null,
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

/**
 * Random username conforming to the canonical signup rule (3–12 chars,
 * [a-zA-Z0-9_]). Use this for register-endpoint inputs.
 */
function uname(prefix: string) {
  return `${prefix}${randomBytes(6).toString("hex")}`.slice(0, 12);
}

maybe("Bearer-auth smoke: cookie isolation and 401→refresh→retry", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let authLib: typeof import("../lib/auth.js");
  const createdUserIds: string[] = [];

  /**
   * Create a session row directly in the DB and return signed tokens.
   * This bypasses HTTP login so the session is not vulnerable to a concurrent
   * backup-restore TRUNCATE that fires between login and the next request.
   */
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
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-bearer-smoke";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    authLib = await import("../lib/auth.js");
  });

  afterAll(async () => {
    if (!SHOULD_RUN || createdUserIds.length === 0) return;
    const { db, auditLogs, userSessions, organizationMemberships, users } =
      dbMod as any;
    await db
      .delete(auditLogs)
      .where(inArray(auditLogs.userId, createdUserIds));
    await db
      .delete(userSessions)
      .where(inArray(userSessions.userId, createdUserIds));
    await db
      .delete(organizationMemberships)
      .where(inArray(organizationMemberships.userId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
  });

  // ── Cookie-jar isolation ──────────────────────────────────────────────────

  it("POST /api/auth/login with clientType:mobile — response carries no Set-Cookie header", async () => {
    const username = uname("clog");
    const reg = await request(appMod.default)
      .post("/api/auth/register")
      .send({ username, password: "TestSmoke1!", email: `${username}@example.com`, userType: "lab", clientType: "mobile" });
    expect(reg.status).toBe(200);
    if (reg.body.user?.id) createdUserIds.push(reg.body.user.id);

    const login = await request(appMod.default)
      .post("/api/auth/login")
      .send({ identifier: username, password: "TestSmoke1!", clientType: "mobile" });

    expect(login.status).toBe(200);
    expect(login.body.success).toBe(true);
    expect(typeof login.body.accessToken).toBe("string");
    expect(typeof login.body.refreshToken).toBe("string");

    // The server must NOT set auth cookies for bearer (mobile) clients.
    // Doing so would silently attach cookies to subsequent RN fetch requests,
    // which trips the CSRF guard (403) when the in-memory bearer is absent.
    const setCookieHeader = login.headers["set-cookie"];
    const cookieNames = Array.isArray(setCookieHeader)
      ? setCookieHeader.map((c: string) => c.split("=")[0])
      : [];
    expect(cookieNames).not.toContain("lt_access");
    expect(cookieNames).not.toContain("lt_refresh");
    expect(cookieNames).not.toContain("lt_csrf");
  }, 20000);

  it("POST /api/auth/refresh with refreshToken in body (clientType:mobile) — response carries no Set-Cookie header", async () => {
    const username = uname("cref");
    const reg = await request(appMod.default)
      .post("/api/auth/register")
      .send({ username, password: "TestSmoke2!", email: `${username}@example.com`, userType: "lab", clientType: "mobile" });
    expect(reg.status).toBe(200);
    if (reg.body.user?.id) createdUserIds.push(reg.body.user.id);

    const login = await request(appMod.default)
      .post("/api/auth/login")
      .send({ identifier: username, password: "TestSmoke2!", clientType: "mobile" });
    expect(login.status).toBe(200);
    const { refreshToken } = login.body;

    const refresh = await request(appMod.default)
      .post("/api/auth/refresh")
      .send({ refreshToken, clientType: "mobile" });

    expect(refresh.status).toBe(200);
    const newAccessToken: unknown =
      refresh.body.data?.accessToken ?? refresh.body.accessToken;
    expect(typeof newAccessToken).toBe("string");

    // Bearer refresh must never set auth cookies.
    const setCookieHeader = refresh.headers["set-cookie"];
    const cookieNames = Array.isArray(setCookieHeader)
      ? setCookieHeader.map((c: string) => c.split("=")[0])
      : [];
    expect(cookieNames).not.toContain("lt_access");
    expect(cookieNames).not.toContain("lt_refresh");
    expect(cookieNames).not.toContain("lt_csrf");
  }, 20000);

  // ── 401 → refresh → retry (end-to-end bearer cycle) ──────────────────────

  it("401 on invalid access token → POST /auth/refresh → new token → protected request returns 200", async () => {
    const username = uname("rtry");
    const reg = await request(appMod.default)
      .post("/api/auth/register")
      .send({ username, password: "TestSmoke3!", email: `${username}@example.com`, userType: "lab", clientType: "mobile" });
    expect(reg.status).toBe(200);
    const userId: string = reg.body.user?.id;
    expect(typeof userId).toBe("string");
    createdUserIds.push(userId);

    // Create the session directly in the DB instead of via HTTP login.
    // This prevents the session from being wiped by a concurrent backup-restore
    // TRUNCATE that could fire in the window between login and the refresh call.
    const { refresh: refreshToken } = await makeSession(userId);

    // Step 1: simulate an expired / tampered access token → server returns 401.
    const expiredToken = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.ZmFrZQ";
    const step1 = await request(appMod.default)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${expiredToken}`);
    expect(step1.status).toBe(401);

    // Step 2: mobile client posts refresh token to get a fresh access token.
    // makeSession is called right before this point so the window for a
    // concurrent TRUNCATE to wipe the session is microseconds, not seconds.
    const { refresh: freshRefresh } = await makeSession(userId);
    const refreshRes = await request(appMod.default)
      .post("/api/auth/refresh")
      .send({ refreshToken: freshRefresh, clientType: "mobile" });
    expect(refreshRes.status).toBe(200);
    const newAccessToken: string =
      refreshRes.body.data?.accessToken ?? refreshRes.body.accessToken;
    expect(typeof newAccessToken).toBe("string");

    // Step 3: retry the originally-failing request with the new token → 200.
    const step3 = await request(appMod.default)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${newAccessToken}`);
    expect(step3.status).toBe(200);
    expect(step3.body.user?.username).toBe(username);
  }, 20000);
});
