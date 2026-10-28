/**
 * Integration tests for PIN-only verification used by the admin-settings gate.
 * Skipped when the API test database is not configured.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import request from "supertest";

const shouldRun = !!process.env["DATABASE_URL"];
const maybeDescribe = shouldRun ? describe : describe.skip;

function randomId(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybeDescribe("POST /api/admin/pin/verify", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let auth: typeof import("../lib/auth.js");
  let adminId: string;
  let staffId: string;
  let adminAccess = "";
  let staffAccess = "";
  let effectivePin = "";

  async function makeSession(userId: string): Promise<string> {
    const sessionId = randomId("pinverify_session");
    const access = auth.signAccessToken(userId, sessionId);
    const tokenHash = createHash("sha256").update(access).digest("hex");
    await dbMod.db.insert(dbMod.userSessions).values({
      id: sessionId,
      userId,
      tokenHash,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    return access;
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] ??= "test-secret-admin-pin-verify";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    auth = await import("../lib/auth.js");
    const { hashPassword } = await import("../lib/crypto.js");
    const { getEffectiveAdminPinAsync } = await import("../lib/admin-pin.js");
    effectivePin = await getEffectiveAdminPinAsync();

    adminId = randomId("pinverify_admin");
    staffId = randomId("pinverify_user");
    const password = await hashPassword("test-password-123");
    await dbMod.db.insert(dbMod.users).values([
      {
        id: adminId,
        username: adminId,
        email: `${adminId}@test.example`,
        password,
        firstName: "PIN",
        lastName: "Admin",
        userType: "lab",
        role: "admin",
      },
      {
        id: staffId,
        username: staffId,
        email: `${staffId}@test.example`,
        password,
        firstName: "PIN",
        lastName: "User",
        userType: "lab",
        role: "user",
      },
    ]);
    adminAccess = await makeSession(adminId);
    staffAccess = await makeSession(staffId);
  });

  afterAll(async () => {
    if (!dbMod || !adminId || !staffId) return;
    await dbMod.db.delete(dbMod.userSessions).where(
      (await import("drizzle-orm")).eq(dbMod.userSessions.userId, adminId),
    );
    await dbMod.db.delete(dbMod.userSessions).where(
      (await import("drizzle-orm")).eq(dbMod.userSessions.userId, staffId),
    );
    await dbMod.db.delete(dbMod.users).where(
      (await import("drizzle-orm")).eq(dbMod.users.id, adminId),
    );
    await dbMod.db.delete(dbMod.users).where(
      (await import("drizzle-orm")).eq(dbMod.users.id, staffId),
    );
  });

  it("accepts the configured PIN without creating a platform-admin session", async () => {
    expect(effectivePin).toMatch(/^\d{4}$/);
    const response = await request(appMod.default)
      .post("/api/admin/pin/verify")
      .set("Authorization", `Bearer ${adminAccess}`)
      .send({ pin: effectivePin });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(response.body.sessionToken).toBeUndefined();
    expect(response.body.expiresAt).toBeUndefined();
  });

  it("rejects an incorrect PIN and malformed input", async () => {
    const wrongPin = `${effectivePin.slice(0, 3)}${effectivePin.endsWith("0") ? "1" : "0"}`;
    const invalid = await request(appMod.default)
      .post("/api/admin/pin/verify")
      .set("Authorization", `Bearer ${adminAccess}`)
      .send({ pin: wrongPin });
    expect(invalid.status).toBe(403);
    expect(invalid.body.error).toMatch(/incorrect/i);

    const malformed = await request(appMod.default)
      .post("/api/admin/pin/verify")
      .set("Authorization", `Bearer ${adminAccess}`)
      .send({ pin: "12x4" });
    expect(malformed.status).toBe(400);
  });

  it("requires an authenticated administrator", async () => {
    const unauthenticated = await request(appMod.default)
      .post("/api/admin/pin/verify")
      .send({ pin: effectivePin });
    expect(unauthenticated.status).toBe(401);

    const nonAdmin = await request(appMod.default)
      .post("/api/admin/pin/verify")
      .set("Authorization", `Bearer ${staffAccess}`)
      .send({ pin: effectivePin });
    expect(nonAdmin.status).toBe(403);
  });
});
