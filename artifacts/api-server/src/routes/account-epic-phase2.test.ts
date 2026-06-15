/**
 * DB-backed behavioural tests for Account epic Phase 2.
 *
 * Skipped when DATABASE_URL is not configured. All inserted rows are removed
 * in afterAll so the suite is safe to run against a shared dev DB.
 *
 * Coverage:
 *  - Username rules (3–12 chars, [a-zA-Z0-9_] only) rejected with 400.
 *  - Case-insensitive username uniqueness → 409.
 *  - Canonical platform account number `<TYPE>-<YEAR>-<SEQ>-<PHONE>` on register.
 *  - Phone normalized into the account-number phone segment.
 *  - requireVerifiedAccount: canonical + unverified account blocked (403) on a
 *    PHI route; grandfathered (legacy / null account-number) account NOT blocked
 *    for the verification reason.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { inArray, eq } from "drizzle-orm";
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
  caseMediaDir: path.join(require("os").tmpdir(), "labtrax-test-media-ae-p2"),
  extractMediaFileName: () => null,
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

const CANONICAL = /^[LP]-\d{4}-\d+(-\d{10})?$/;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

/** Random 3–12 char username from the allowed charset. */
function uname(prefix: string) {
  return `${prefix}${randomBytes(3).toString("hex")}`.slice(0, 12);
}

maybe("Account epic Phase 2 (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };

  const createdUserIds: string[] = [];

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-ae-p2";
    // Enforcement must be ON for these tests.
    delete process.env["DISABLE_VERIFICATION_ENFORCEMENT"];
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
  });

  afterAll(async () => {
    if (!SHOULD_RUN || createdUserIds.length === 0) return;
    const {
      db,
      auditLogs,
      userSessions,
      organizationMemberships,
      users,
    } = dbMod as any;
    await db.delete(auditLogs).where(inArray(auditLogs.userId, createdUserIds));
    await db
      .delete(userSessions)
      .where(inArray(userSessions.userId, createdUserIds));
    await db
      .delete(organizationMemberships)
      .where(inArray(organizationMemberships.userId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
  });

  // ── Username rules ────────────────────────────────────────────────────────

  it("rejects a username shorter than 3 chars (400)", async () => {
    const r = await request(appMod.default)
      .post("/api/auth/register")
      .send({ username: "ab", password: "TestPass1!", clientType: "mobile" });
    expect(r.status).toBe(400);
  });

  it("rejects a username longer than 12 chars (400)", async () => {
    const r = await request(appMod.default)
      .post("/api/auth/register")
      .send({
        username: "thisusernameistoolong",
        password: "TestPass1!",
        clientType: "mobile",
      });
    expect(r.status).toBe(400);
  });

  it("rejects a username with disallowed characters (400)", async () => {
    const r = await request(appMod.default)
      .post("/api/auth/register")
      .send({ username: "bad name!", password: "TestPass1!", clientType: "mobile" });
    expect(r.status).toBe(400);
  });

  it("enforces case-insensitive username uniqueness (409)", async () => {
    const base = uname("Case");
    const first = await request(appMod.default)
      .post("/api/auth/register")
      .send({
        username: base,
        password: "TestPass1!",
        email: `${base}.1@example.com`,
        userType: "lab",
        clientType: "mobile",
      });
    expect(first.status).toBe(200);
    if (first.body.user?.id) createdUserIds.push(first.body.user.id);

    const second = await request(appMod.default)
      .post("/api/auth/register")
      .send({
        username: base.toUpperCase(),
        password: "TestPass1!",
        email: `${base}.2@example.com`,
        userType: "lab",
        clientType: "mobile",
      });
    expect(second.status).toBe(409);
  });

  // ── Canonical account number ──────────────────────────────────────────────

  it("assigns a canonical platform account number with phone segment", async () => {
    const r = await request(appMod.default)
      .post("/api/auth/register")
      .send({
        username: uname("lab"),
        password: "TestPass1!",
        email: `${rid("lab")}@example.com`,
        userType: "lab",
        phone: "(555) 123-4567",
        clientType: "mobile",
      });
    expect(r.status).toBe(200);
    if (r.body.user?.id) createdUserIds.push(r.body.user.id);
    const pan = r.body.user.platformAccountNumber as string;
    expect(pan).toMatch(CANONICAL);
    expect(pan.startsWith("L-")).toBe(true);
    expect(pan.endsWith("-5551234567")).toBe(true);
  });

  it("assigns a P-type canonical number for providers, no phone segment when absent", async () => {
    const r = await request(appMod.default)
      .post("/api/auth/register")
      .send({
        username: uname("prov"),
        password: "TestPass1!",
        email: `${rid("prov")}@example.com`,
        userType: "provider",
        clientType: "mobile",
      });
    expect(r.status).toBe(200);
    if (r.body.user?.id) createdUserIds.push(r.body.user.id);
    const pan = r.body.user.platformAccountNumber as string;
    expect(pan).toMatch(CANONICAL);
    expect(pan.startsWith("P-")).toBe(true);
    // No phone supplied → no trailing 10-digit segment.
    expect(/-\d{10}$/.test(pan)).toBe(false);
  });

  // ── Verification enforcement ──────────────────────────────────────────────

  it("blocks a canonical unverified account from a PHI route (403), then allows after verification", async () => {
    const reg = await request(appMod.default)
      .post("/api/auth/register")
      .send({
        username: uname("phi"),
        password: "TestPass1!",
        email: `${rid("phi")}@example.com`,
        userType: "lab",
        phone: "5550001111",
        clientType: "mobile",
      });
    expect(reg.status).toBe(200);
    const userId = reg.body.user.id as string;
    createdUserIds.push(userId);
    const token = reg.body.accessToken as string;
    expect(reg.body.user.platformAccountNumber).toMatch(CANONICAL);

    // Unverified → blocked on PHI route.
    const blocked = await request(appMod.default)
      .get("/api/cases")
      .set("Authorization", `Bearer ${token}`);
    expect(blocked.status).toBe(403);

    // Verify the email out-of-band (simulate completed verification).
    const { db, users } = dbMod as any;
    await db
      .update(users)
      .set({ emailVerifiedAt: new Date() })
      .where(eq(users.id, userId));

    // Now the verification gate passes (no longer 403 for that reason).
    const allowed = await request(appMod.default)
      .get("/api/cases")
      .set("Authorization", `Bearer ${token}`);
    expect(allowed.status).not.toBe(403);
  });

  it("grandfathers a legacy (non-canonical account number) user past the verification gate", async () => {
    const { db, users } = dbMod as any;
    const legacyId = rid("legacy");
    // Randomize the legacy (non-canonical) account number per run so a leftover
    // row from an aborted run — or a real backfilled "<seq><YY><F><L>" account
    // already in a shared DB — cannot collide on
    // users_platform_account_number_unique. Format stays legacy (no hyphens),
    // so it never matches the CANONICAL regex.
    const legacyAcct = `${randomBytes(3).toString("hex").toUpperCase()}26JW`;
    await db.insert(users).values({
      id: legacyId,
      username: uname("leg"),
      password: "TestLogin1!",
      platformAccountNumber: legacyAcct, // legacy format, not canonical
    });
    createdUserIds.push(legacyId);

    const login = await request(appMod.default)
      .post("/api/auth/login")
      .send({ identifier: legacyAcct, password: "TestLogin1!", clientType: "mobile" });
    expect(login.status).toBe(200);
    const token = login.body.accessToken as string;

    // Legacy account is unverified but grandfathered → not blocked for the
    // verification reason (any non-403 status is acceptable here).
    const r = await request(appMod.default)
      .get("/api/cases")
      .set("Authorization", `Bearer ${token}`);
    expect(r.status).not.toBe(403);
  });
});
