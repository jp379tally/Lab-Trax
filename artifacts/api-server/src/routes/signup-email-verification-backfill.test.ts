/**
 * DB-backed regression test for the pre-registration email verification
 * backfill on POST /api/register.
 *
 * Scenario: a user verifies their email (via the signup wizard OTP step)
 * *before* their account exists. The verify-email-code route cannot write
 * emailVerifiedAt because req.auth is null at that point. When POST /api/register
 * later creates the account with that same email, the register handler must
 * detect the recent consumed verification code and backfill emailVerifiedAt
 * so requireVerifiedAccount passes immediately — no "verification required" banner.
 *
 * Skipped when DATABASE_URL is not configured.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
  caseMediaDir: path.join(require("os").tmpdir(), "labtrax-test-media-backfill"),
  extractMediaFileName: () => null,
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

vi.setConfig({ testTimeout: 60000, hookTimeout: 90000 });

function rid(prefix: string) {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

maybe("POST /api/register — pre-registration email verification backfill", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let verifyLib: typeof import("../lib/verification.js");

  const suffix = randomBytes(4).toString("hex");
  const username = `bf_${suffix}`;
  const email = `backfill_${suffix}@test.local`;
  const password = "TestPassword1!";

  const createdUserIds: string[] = [];

  beforeAll(async () => {
    process.env["JWT_SECRET"] = process.env["JWT_SECRET"] ?? "labtrax-test-secret-backfill";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    verifyLib = await import("../lib/verification.js");
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const { db, auditLogs, userSessions, verificationCodes, users, organizationMemberships, organizations } =
      dbMod as any;
    if (createdUserIds.length > 0) {
      await db.delete(auditLogs).where(inArray(auditLogs.userId, createdUserIds));
      await db.delete(userSessions).where(inArray(userSessions.userId, createdUserIds));
      const memberships = await db
        .select()
        .from(organizationMemberships)
        .where(inArray(organizationMemberships.userId, createdUserIds));
      const orgIds = memberships.map((m: any) => m.labId);
      await db.delete(organizationMemberships).where(inArray(organizationMemberships.userId, createdUserIds));
      if (orgIds.length > 0) {
        await db.delete(organizations).where(inArray(organizations.id, orgIds));
      }
      await db.delete(users).where(inArray(users.id, createdUserIds));
    }
    await db
      .delete(verificationCodes)
      .where(eq(verificationCodes.target, verifyLib.normalizeEmailTarget(email)));
  });

  it("sets emailVerifiedAt on a newly registered user whose email was verified before account creation", async () => {
    const target = verifyLib.normalizeEmailTarget(email);

    // (a) Send a verification code for the email address (pre-account).
    const sendRes = await request(appMod.default)
      .post("/api/send-email-code")
      .send({ email });
    expect(sendRes.status).toBe(200);
    expect(sendRes.body.success).toBe(true);

    // Seed a known code directly so we don't depend on dev-mode demoCode.
    const code = "737373";
    await verifyLib.createVerificationCode({ channel: "email", target, code });

    // (b) Verify the code unauthenticated — simulates the signup wizard OTP
    //     step before the account exists. No Authorization header is sent.
    const verifyRes = await request(appMod.default)
      .post("/api/verify-email-code")
      .send({ email, code });
    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.verified).toBe(true);

    // (c) Register the account with the same email.
    const registerRes = await request(appMod.default)
      .post("/api/register")
      .send({
        username,
        password,
        email,
        userType: "lab",
        clientType: "mobile",
      });
    expect(registerRes.status).toBe(200);

    const userId: string = registerRes.body.user?.id;
    expect(userId).toBeTruthy();
    createdUserIds.push(userId);

    // (d) The returned user should already have emailVerifiedAt set so that
    //     requireVerifiedAccount does not block the new account.
    const { db, users } = dbMod as any;
    const [dbUser] = await db.select().from(users).where(eq(users.id, userId));
    expect(dbUser.emailVerifiedAt).toBeTruthy();
  });

  it("does NOT set emailVerifiedAt when no pre-registration verification code exists for the email", async () => {
    const freshSuffix = randomBytes(4).toString("hex");
    const freshUsername = `bf2_${freshSuffix}`;
    const freshEmail = `no_preverify_${freshSuffix}@test.local`;

    const registerRes = await request(appMod.default)
      .post("/api/register")
      .send({
        username: freshUsername,
        password,
        email: freshEmail,
        userType: "lab",
        clientType: "mobile",
      });
    expect(registerRes.status).toBe(200);

    const userId: string = registerRes.body.user?.id;
    expect(userId).toBeTruthy();
    createdUserIds.push(userId);

    const { db, users } = dbMod as any;
    const [dbUser] = await db.select().from(users).where(eq(users.id, userId));
    expect(dbUser.emailVerifiedAt).toBeNull();
  });
});
