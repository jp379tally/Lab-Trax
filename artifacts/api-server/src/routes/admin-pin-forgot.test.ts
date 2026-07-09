/**
 * Integration tests for the admin PIN reset request flow:
 *   POST /api/admin/pin/forgot — emails a 6-digit reset code to the signed-in
 *   admin's own email address and returns { ok, maskedEmail }.
 *
 * Email sending goes through a mocked sendMail so tests can assert the reset
 * code is emailed and that no SMS is ever sent (the flow is email-only).
 *
 * Skipped when DATABASE_URL is not configured (matches sibling suite convention).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { inArray } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";
import request from "supertest";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
}));

// Mock only sendMail (keep the rest of the mail module intact) so the suite
// can assert the PIN reset code is emailed.
vi.mock("../lib/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/mail.js")>();
  return {
    ...actual,
    sendMail: vi.fn().mockResolvedValue({ sent: true }),
  };
});

vi.mock("../lib/sms.js", () => ({
  sendSms: vi.fn().mockResolvedValue({ ok: true, skipped: true }),
  isConfigured: vi.fn().mockReturnValue(false),
  isDevOrTest: vi.fn().mockReturnValue(true),
  sendVerificationSms: vi.fn().mockResolvedValue(undefined),
  parseInboundSms: vi.fn().mockReturnValue(null),
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("Admin PIN forgot flow (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let auth: typeof import("../lib/auth.js");

  const adminUserId = rid("uadmin");
  const noEmailAdminId = rid("uadmnoe");
  const regularUserId = rid("ureg");

  async function makeSession(userId: string): Promise<string> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const token = auth.signAccessToken(userId, sessionId);
    const hash = createHash("sha256").update(token).digest("hex");
    await db.insert(userSessions).values({ id: sessionId, userId, tokenHash: hash, expiresAt });
    return token;
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] = process.env["JWT_SECRET"] ?? "labtrax-pin-forgot-test-secret";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    auth = await import("../lib/auth.js");

    const { db, users } = dbMod as any;
    await db.insert(users).values([
      {
        id: adminUserId,
        username: `pfg_adm_${adminUserId}`,
        password: "x",
        role: "admin",
        email: `${adminUserId}@test.local`,
      },
      {
        id: noEmailAdminId,
        username: `pfg_noe_${noEmailAdminId}`,
        password: "x",
        role: "admin",
        // intentionally no email — triggers the 400 guard
      },
      {
        id: regularUserId,
        username: `pfg_reg_${regularUserId}`,
        password: "x",
        role: "user",
        email: `${regularUserId}@test.local`,
      },
    ]);
  }, 60_000);

  // Refresh session tokens before every test so a concurrent user_sessions
  // wipe does not invalidate shared tokens mid-suite.
  const tokens = { admin: "", noEmail: "", regular: "" };
  beforeEach(async () => {
    tokens.admin = await makeSession(adminUserId);
    tokens.noEmail = await makeSession(noEmailAdminId);
    tokens.regular = await makeSession(regularUserId);
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const { db, users, userSessions, systemSettings } = dbMod as any;
    // Clear any reset code written by the happy-path test (global singleton keys).
    await db
      .delete(systemSettings)
      .where(inArray(systemSettings.key, ["admin_pin_reset_code", "admin_pin_reset_expires"]));
    await db
      .delete(userSessions)
      .where(inArray(userSessions.userId, [adminUserId, noEmailAdminId, regularUserId]));
    await db.delete(users).where(inArray(users.id, [adminUserId, noEmailAdminId, regularUserId]));
  });

  it("returns 401 when no auth token is provided", async () => {
    const r = await request(appMod.default).post("/api/admin/pin/forgot").send({});
    expect(r.status).toBe(401);
  });

  it("returns 403 when caller is not a global admin", async () => {
    const r = await request(appMod.default)
      .post("/api/admin/pin/forgot")
      .set("Authorization", `Bearer ${tokens.regular}`)
      .send({});
    expect(r.status).toBe(403);
  });

  it("returns 400 when the admin has no email address on file", async () => {
    const { sendMail } = await import("../lib/mail.js");
    (sendMail as ReturnType<typeof vi.fn>).mockClear();
    const r = await request(appMod.default)
      .post("/api/admin/pin/forgot")
      .set("Authorization", `Bearer ${tokens.noEmail}`)
      .send({});
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/email/i);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("emails the reset code and returns maskedEmail on happy path (no SMS)", async () => {
    const { sendMail } = await import("../lib/mail.js");
    const { sendSms } = await import("../lib/sms.js");
    (sendMail as ReturnType<typeof vi.fn>).mockClear();
    (sendSms as ReturnType<typeof vi.fn>).mockClear();

    const r = await request(appMod.default)
      .post("/api/admin/pin/forgot")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({});
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    // Mask format: first char + *** + @domain (e.g. "u***@test.local")
    expect(r.body.maskedEmail).toBe(`${adminUserId[0]}***@test.local`);

    // Reset code must be delivered by email — never by SMS.
    expect(sendMail).toHaveBeenCalledTimes(1);
    const mailArg = (sendMail as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(mailArg.to).toBe(`${adminUserId}@test.local`);
    expect(mailArg.text).toMatch(/\d{6}/);
    expect(sendSms).not.toHaveBeenCalled();

    // The emailed code matches the one persisted for verify-reset.
    const { db, systemSettings } = dbMod as any;
    const rows = await db
      .select()
      .from(systemSettings)
      .where(inArray(systemSettings.key, ["admin_pin_reset_code", "admin_pin_reset_expires"]));
    const stored = rows.find((row: any) => row.key === "admin_pin_reset_code")?.value;
    expect(stored).toMatch(/^\d{6}$/);
    expect(mailArg.text).toContain(stored);
  });
});
