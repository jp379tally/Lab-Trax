/**
 * Integration tests for the 3-step case deletion security flow:
 *   POST /api/cases/delete-initiate  — validates admin PIN, finds lab owner,
 *                                       sends SMS OTP, returns signed session token
 *   POST /api/cases/bulk-delete      — now requires token + OTP (security gate)
 *
 * The verification module is mocked so no real DB writes or SMS calls are
 * needed for the OTP phase; SMS sending falls through to the dev-mode
 * console.warn path (no SMS provider env vars configured in the test environment).
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

// Mock verification so tests don't require a populated verification_codes table.
// verifyCode defaults to returning {verified:true}; individual tests can
// override it for one call via mockResolvedValueOnce.
vi.mock("../lib/verification.js", () => ({
  createVerificationCode: vi.fn().mockResolvedValue(undefined),
  verifyCode: vi.fn().mockResolvedValue({ verified: true }),
  normalizePhoneTarget: (p: string) => p.replace(/\D/g, ""),
}));

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

maybe("Case delete security flow (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let auth: typeof import("../lib/auth.js");

  // Main test lab: owner has a verified phone.
  const labOrgId = rid("lab");
  const adminUserId = rid("uadmin");
  const staffUserId = rid("ustaff");

  // Secondary lab: owner has no verified phone — tests the 400 guard.
  const noPhoneLabId = rid("noplab");
  const noPhoneUserId = rid("unophone");

  const tokens = { admin: "", staff: "", noPhone: "" };

  async function makeSession(userId: string): Promise<string> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const token = auth.signAccessToken(userId, sessionId);
    const hash = createHash("sha256").update(token).digest("hex");
    await db.insert(userSessions).values({ id: sessionId, userId, tokenHash: hash, expiresAt });
    return token;
  }

  async function insertCanonical(orgId = labOrgId): Promise<string> {
    const { db, cases } = dbMod as any;
    const id = rid("c");
    await db.insert(cases).values({
      id,
      caseNumber: rid("CN"),
      labOrganizationId: orgId,
      providerOrganizationId: orgId,
      doctorName: "Dr. Pin Test",
      patientFirstName: "Pat",
      patientLastName: "Test",
      status: "draft",
      createdByUserId: adminUserId,
    });
    return id;
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] = process.env["JWT_SECRET"] ?? "labtrax-delete-pin-test-secret";
    process.env["PLATFORM_ADMIN_PIN"] = "testpin999";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    auth = await import("../lib/auth.js");

    const { db, organizations, users, organizationMemberships } = dbMod as any;

    await db.insert(users).values([
      {
        id: adminUserId,
        username: `pin_adm_${adminUserId}`,
        password: "x",
        phone: "5550007777",
        phoneVerifiedAt: new Date(),
      },
      { id: staffUserId, username: `pin_stf_${staffUserId}`, password: "x" },
      {
        id: noPhoneUserId,
        username: `pin_noph_${noPhoneUserId}`,
        password: "x",
        // intentionally no phone / phoneVerifiedAt
      },
    ]);

    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: "Pin Test Lab" },
      { id: noPhoneLabId, type: "lab", name: "No Phone Lab" },
    ]);

    await db.insert(organizationMemberships).values([
      { id: rid("m"), labId: labOrgId, userId: adminUserId, role: "owner", status: "active" },
      { id: rid("m"), labId: labOrgId, userId: staffUserId, role: "staff", status: "active" },
      { id: rid("m"), labId: noPhoneLabId, userId: noPhoneUserId, role: "owner", status: "active" },
    ]);

  }, 60_000);

  // Refresh session tokens before every test so a concurrent user_sessions
  // wipe does not invalidate shared tokens mid-suite.
  beforeEach(async () => {
    tokens.admin = await makeSession(adminUserId);
    tokens.staff = await makeSession(staffUserId);
    tokens.noPhone = await makeSession(noPhoneUserId);
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const { db, organizations, users, cases, organizationMemberships, userSessions, auditLogs } =
      dbMod as any;
    await db
      .delete(auditLogs)
      .where(inArray(auditLogs.organizationId, [labOrgId, noPhoneLabId]));
    await db
      .delete(cases)
      .where(inArray(cases.labOrganizationId, [labOrgId, noPhoneLabId]));
    await db
      .delete(organizationMemberships)
      .where(inArray(organizationMemberships.userId, [adminUserId, staffUserId, noPhoneUserId]));
    await db
      .delete(userSessions)
      .where(inArray(userSessions.userId, [adminUserId, staffUserId, noPhoneUserId]));
    await db.delete(organizations).where(inArray(organizations.id, [labOrgId, noPhoneLabId]));
    await db.delete(users).where(inArray(users.id, [adminUserId, staffUserId, noPhoneUserId]));
  });

  // ── POST /api/cases/delete-initiate ────────────────────────────────────────

  it("returns 401 when no auth token is provided", async () => {
    const c = await insertCanonical();
    const r = await request(appMod.default)
      .post("/api/cases/delete-initiate")
      .send({ adminPin: "testpin999", caseIds: [c] });
    expect(r.status).toBe(401);
  });

  it("returns 403 when caller is staff (not admin/owner)", async () => {
    const staffToken = await makeSession(staffUserId);
    const c = await insertCanonical();
    const r = await request(appMod.default)
      .post("/api/cases/delete-initiate")
      .set("Authorization", `Bearer ${staffToken}`)
      .send({ adminPin: "testpin999", caseIds: [c] });
    expect(r.status).toBe(403);
  });

  it("returns 401 when admin PIN is wrong", async () => {
    const adminToken = await makeSession(adminUserId);
    const c = await insertCanonical();
    const r = await request(appMod.default)
      .post("/api/cases/delete-initiate")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ adminPin: "wrongpin", caseIds: [c] });
    expect(r.status).toBe(401);
    expect(r.body.error).toMatch(/incorrect.*pin/i);
  });

  it("returns 404 when no case matches the provided IDs", async () => {
    const adminToken = await makeSession(adminUserId);
    const r = await request(appMod.default)
      .post("/api/cases/delete-initiate")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ adminPin: "testpin999", caseIds: [rid("ghost")] });
    expect(r.status).toBe(404);
  });

  it("returns 400 when lab owner has no verified phone number", async () => {
    const noPhoneToken = await makeSession(noPhoneUserId);
    const c = await insertCanonical(noPhoneLabId);
    const r = await request(appMod.default)
      .post("/api/cases/delete-initiate")
      .set("Authorization", `Bearer ${noPhoneToken}`)
      .send({ adminPin: "testpin999", caseIds: [c] });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/phone/i);
  });

  it("returns 200 and a signed deleteSessionToken on happy path", async () => {
    const adminToken = await makeSession(adminUserId);
    const c = await insertCanonical();
    const r = await request(appMod.default)
      .post("/api/cases/delete-initiate")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ adminPin: "testpin999", caseIds: [c] });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(typeof r.body.data.deleteSessionToken).toBe("string");
  });

  // ── POST /api/cases/bulk-delete security gate ──────────────────────────────

  it("returns 403 when bulk-delete is called without a token or OTP", async () => {
    const adminToken = await makeSession(adminUserId);
    const c = await insertCanonical();
    const r = await request(appMod.default)
      .post("/api/cases/bulk-delete")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ caseIds: [c] });
    expect(r.status).toBe(403);
    // Case must not be deleted.
    const { db, cases } = dbMod as any;
    const [row] = await db
      .select({ deletedAt: cases.deletedAt })
      .from(cases)
      .where(inArray(cases.id, [c]));
    expect(row.deletedAt).toBeNull();
  });

  it("returns 401 when bulk-delete is called with an invalid session token", async () => {
    const adminToken = await makeSession(adminUserId);
    const c = await insertCanonical();
    const r = await request(appMod.default)
      .post("/api/cases/bulk-delete")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ caseIds: [c], deleteSessionToken: "not.a.valid.token", smsOtpCode: "123456" });
    expect(r.status).toBe(401);
  });

  it("returns 400 when OTP does not match (verifyCode returns not-verified)", async () => {
    const adminToken = await makeSession(adminUserId);
    const { verifyCode } = await import("../lib/verification.js");
    (verifyCode as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      verified: false,
      error: "Invalid code",
    });

    const c = await insertCanonical();
    const init = await request(appMod.default)
      .post("/api/cases/delete-initiate")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ adminPin: "testpin999", caseIds: [c] });
    expect(init.status).toBe(200);

    const del = await request(appMod.default)
      .post("/api/cases/bulk-delete")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        caseIds: [c],
        deleteSessionToken: init.body.data.deleteSessionToken,
        smsOtpCode: "000000",
      });
    expect(del.status).toBe(400);

    // Case must not be deleted.
    const { db, cases } = dbMod as any;
    const [row] = await db
      .select({ deletedAt: cases.deletedAt })
      .from(cases)
      .where(inArray(cases.id, [c]));
    expect(row.deletedAt).toBeNull();
  });

  it("soft-deletes cases when the full 3-step flow completes successfully", async () => {
    const adminToken = await makeSession(adminUserId);
    const c = await insertCanonical();

    const init = await request(appMod.default)
      .post("/api/cases/delete-initiate")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ adminPin: "testpin999", caseIds: [c] });
    expect(init.status).toBe(200);

    const del = await request(appMod.default)
      .post("/api/cases/bulk-delete")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        caseIds: [c],
        deleteSessionToken: init.body.data.deleteSessionToken,
        smsOtpCode: "123456",
      });
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);
    expect(del.body.data.deletedCount).toBe(1);

    // Soft-delete: row still exists but deletedAt is set.
    const { db, cases } = dbMod as any;
    const [row] = await db
      .select({ deletedAt: cases.deletedAt })
      .from(cases)
      .where(inArray(cases.id, [c]));
    expect(row.deletedAt).not.toBeNull();
  });
});
