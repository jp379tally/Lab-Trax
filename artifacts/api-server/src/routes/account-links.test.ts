/**
 * Integration tests for cross-lab doctor account linking routes (regression guard).
 *
 * Skipped when DATABASE_URL is not configured. All inserted rows are removed
 * in afterAll so the suite is safe to run against a shared dev DB.
 *
 * Coverage:
 *  - POST /api/account-links/manual — creates a pending invite, not an active link
 *  - POST /api/account-links/respond — only the invited account can respond
 *  - POST /api/account-links/manual — 404 when account number not found
 *  - POST /api/account-links/manual — 400 when linking own account number
 *  - Unauthenticated SMS fields cannot accept account-link invitations
 *  - Unauthenticated /api/account-links/manual returns 401
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { inArray, eq, and } from "drizzle-orm";
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
  caseMediaDir: path.join(require("os").tmpdir(), "labtrax-test-media-acctlinks"),
  extractMediaFileName: () => null,
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("Account links (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let authLib: typeof import("../lib/auth.js");

  const userAId = rid("ua");
  const userBId = rid("ub");
  const ACCT_A = `AAAA${randomBytes(2).toString("hex").toUpperCase()}`;
  const ACCT_B = `BBBB${randomBytes(2).toString("hex").toUpperCase()}`;

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
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-acctlinks";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    authLib = await import("../lib/auth.js");

    const { db, users } = dbMod as any;
    await db.insert(users).values([
      {
        id: userAId,
        username: `acctlinkA_${userAId}`,
        password: "x",
        platformAccountNumber: ACCT_A,
      },
      {
        id: userBId,
        username: `acctlinkB_${userBId}`,
        password: "x",
        platformAccountNumber: ACCT_B,
      },
    ]);
  });

  // Ensure fresh sessions exist before each test; per-test sessions created in
  // each it() body are still the authoritative token for that test.
  beforeEach(async () => {
    await makeSession(userAId);
    await makeSession(userBId);
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const {
      db,
      auditLogs,
      doctorAccountLinks,
      accountLinkInvites,
      userSessions,
      users,
    } = dbMod as any;

    await db.delete(auditLogs).where(inArray(auditLogs.userId, [userAId, userBId]));
    // Remove any links between these test users.
    await db.delete(doctorAccountLinks).where(inArray(doctorAccountLinks.userIdLow, [userAId, userBId]));
    await db.delete(doctorAccountLinks).where(inArray(doctorAccountLinks.userIdHigh, [userAId, userBId]));
    await db.delete(accountLinkInvites).where(inArray(accountLinkInvites.newUserId, [userAId, userBId]));
    await db.delete(accountLinkInvites).where(
      inArray(accountLinkInvites.existingUserId, [userAId, userBId])
    );
    await db.delete(userSessions).where(inArray(userSessions.userId, [userAId, userBId]));
    await db.delete(users).where(inArray(users.id, [userAId, userBId]));
  });

  // ── POST /api/account-links/manual ────────────────────────────────────────

  it("POST /api/account-links/manual creates an invite without linking accounts", async () => {
    const { access } = await makeSession(userAId);
    const { db, accountLinkInvites, doctorAccountLinks } = dbMod as any;

    const r = await request(appMod.default)
      .post("/api/account-links/manual")
      .set("Authorization", `Bearer ${access}`)
      .send({ otherPlatformAccountNumber: ACCT_B });

    expect(r.status).toBe(200);
    expect(r.body.data?.ok ?? r.body.ok).toBe(true);
    expect(r.body.data?.alreadyLinked ?? r.body.alreadyLinked).toBe(false);
    expect(r.body.data?.invitePending ?? r.body.invitePending).toBe(true);

    const invite = await db.query.accountLinkInvites.findFirst({
      where: and(
        eq(accountLinkInvites.newUserId, userAId),
        eq(accountLinkInvites.existingUserId, userBId)
      ),
    });
    expect(invite?.status).toBe("pending");
    const links = await db
      .select()
      .from(doctorAccountLinks)
      .where(
        and(
          inArray(doctorAccountLinks.userIdLow, [userAId, userBId]),
          inArray(doctorAccountLinks.userIdHigh, [userAId, userBId])
        )
      );
    expect(links).toHaveLength(0);
    await db.delete(accountLinkInvites).where(eq(accountLinkInvites.id, invite.id));
  });

  it("POST /api/account-links/manual repeated call reuses the pending invite", async () => {
    const { access } = await makeSession(userAId);
    const { db, accountLinkInvites } = dbMod as any;

    const first = await request(appMod.default)
      .post("/api/account-links/manual")
      .set("Authorization", `Bearer ${access}`)
      .send({ otherPlatformAccountNumber: ACCT_B });

    const second = await request(appMod.default)
      .post("/api/account-links/manual")
      .set("Authorization", `Bearer ${access}`)
      .send({ otherPlatformAccountNumber: ACCT_B });

    expect(second.status).toBe(200);
    expect(first.body.data?.invitePending ?? first.body.invitePending).toBe(true);
    expect(second.body.data?.invitePending ?? second.body.invitePending).toBe(true);

    const invites = await db
      .select()
      .from(accountLinkInvites)
      .where(
        and(
          eq(accountLinkInvites.newUserId, userAId),
          eq(accountLinkInvites.existingUserId, userBId)
        )
      );
    expect(invites).toHaveLength(1);
    await db.delete(accountLinkInvites).where(eq(accountLinkInvites.id, invites[0].id));
  });

  it("POST /api/account-links/manual with unknown account number returns 404", async () => {
    const { access } = await makeSession(userAId);

    const r = await request(appMod.default)
      .post("/api/account-links/manual")
      .set("Authorization", `Bearer ${access}`)
      .send({ otherPlatformAccountNumber: "ZZZZNOTEXIST" });

    expect(r.status).toBe(404);
  });

  it("POST /api/account-links/manual with own account number returns 400", async () => {
    const { access } = await makeSession(userAId);

    const r = await request(appMod.default)
      .post("/api/account-links/manual")
      .set("Authorization", `Bearer ${access}`)
      .send({ otherPlatformAccountNumber: ACCT_A });

    expect(r.status).toBe(400);
  });

  it("unauthenticated POST /api/account-links/manual returns 401", async () => {
    const r = await request(appMod.default)
      .post("/api/account-links/manual")
      .send({ otherPlatformAccountNumber: ACCT_B });
    expect(r.status).toBe(401);
  });

  it("only the invited account can accept a pending link", async () => {
    const { db, accountLinkInvites, doctorAccountLinks } = dbMod as any;
    const { access: requesterToken } = await makeSession(userAId);
    const { access: invitedToken } = await makeSession(userBId);

    await request(appMod.default)
      .post("/api/account-links/manual")
      .set("Authorization", `Bearer ${requesterToken}`)
      .send({ otherPlatformAccountNumber: ACCT_B });
    const invite = await db.query.accountLinkInvites.findFirst({
      where: and(
        eq(accountLinkInvites.newUserId, userAId),
        eq(accountLinkInvites.existingUserId, userBId)
      ),
    });

    const requesterResponse = await request(appMod.default)
      .post("/api/account-links/respond")
      .set("Authorization", `Bearer ${requesterToken}`)
      .send({ inviteId: invite.id, accept: true });
    expect(requesterResponse.status).toBe(403);
    expect((await db.query.accountLinkInvites.findFirst({
      where: eq(accountLinkInvites.id, invite.id),
    }))?.status).toBe("pending");

    const targetResponse = await request(appMod.default)
      .post("/api/account-links/respond")
      .set("Authorization", `Bearer ${invitedToken}`)
      .send({ inviteId: invite.id, accept: true });
    expect(targetResponse.status).toBe(200);
    expect(targetResponse.body.data?.accepted ?? targetResponse.body.accepted).toBe(true);
    const links = await db
      .select()
      .from(doctorAccountLinks)
      .where(
        and(
          inArray(doctorAccountLinks.userIdLow, [userAId, userBId]),
          inArray(doctorAccountLinks.userIdHigh, [userAId, userBId])
        )
      );
    expect(links).toHaveLength(1);

    await db.delete(accountLinkInvites).where(eq(accountLinkInvites.id, invite.id));
    await db.delete(doctorAccountLinks).where(
      inArray(doctorAccountLinks.userIdLow, [userAId, userBId])
    );
    await db.delete(doctorAccountLinks).where(
      inArray(doctorAccountLinks.userIdHigh, [userAId, userBId])
    );
  });

  // ── POST /api/sms/sms-inbound ──────────────────────────────────────────

  it("unsigned POST /api/sms/sms-inbound cannot accept a pending invite", async () => {
    // Use a numeric-only phone so normalizePhoneE164 keeps all digits intact.
    const suffix = String(1000000 + Math.floor(Math.random() * 9000000));
    const phone = `+1555${suffix}`;
    const { db, accountLinkInvites, doctorAccountLinks } = dbMod as any;

    // Insert a pending invite referencing the phone number.
    await db.insert(accountLinkInvites).values({
      id: rid("inv"),
      newUserId: userAId,
      existingUserId: userBId,
      sentToPhone: phone,
      matchedOn: "email",
      status: "pending",
      sentAt: new Date(),
    });

    try {
      const r = await request(appMod.default)
        .post("/api/sms/sms-inbound")
        .type("form")
        .send({ msisdn: phone, text: "YES" });

      expect(r.status).toBe(404);

      // Caller-supplied phone numbers and message bodies are not consent.
      const invite = await db.query.accountLinkInvites.findFirst({
        where: eq(accountLinkInvites.sentToPhone, phone),
      });
      expect(invite?.status).toBe("pending");
    } finally {
      // Always clean up even if assertions fail, so later tests see a clean slate.
      await db.delete(accountLinkInvites).where(eq(accountLinkInvites.sentToPhone, phone));
      await db.delete(doctorAccountLinks).where(
        inArray(doctorAccountLinks.userIdLow, [userAId, userBId])
      );
      await db.delete(doctorAccountLinks).where(
        inArray(doctorAccountLinks.userIdHigh, [userAId, userBId])
      );
    }
  });

  it("unsigned non-YES SMS requests are not routed to account linking", async () => {
    const suffix = String(2000000 + Math.floor(Math.random() * 9000000));
    const phone = `+1556${suffix}`;
    // Use reversed user pair to avoid unique constraint with the YES test's invite.
    const { db, accountLinkInvites } = dbMod as any;

    await db.insert(accountLinkInvites).values({
      id: rid("inv2"),
      newUserId: userBId,
      existingUserId: userAId,
      sentToPhone: phone,
      matchedOn: "email",
      status: "pending",
      sentAt: new Date(),
    });

    try {
      const r = await request(appMod.default)
        .post("/api/sms/sms-inbound")
        .type("form")
        .send({ msisdn: phone, text: "STOP" });

      expect(r.status).toBe(404);

      const invite = await db.query.accountLinkInvites.findFirst({
        where: eq(accountLinkInvites.sentToPhone, phone),
      });
      expect(invite?.status).toBe("pending");
    } finally {
      await db.delete(accountLinkInvites).where(eq(accountLinkInvites.sentToPhone, phone));
    }
  });

  it("repeated unsigned SMS confirmations cannot create an account link", async () => {
    const suffix = String(3000000 + Math.floor(Math.random() * 9000000));
    const phone = `+1557${suffix}`;
    const { db, accountLinkInvites, doctorAccountLinks } = dbMod as any;

    await db.insert(accountLinkInvites).values({
      id: rid("inv3"),
      newUserId: userAId,
      existingUserId: userBId,
      sentToPhone: phone,
      matchedOn: "email",
      status: "pending",
      sentAt: new Date(),
    });

    try {
      const first = await request(appMod.default)
        .post("/api/sms/sms-inbound")
        .type("form")
        .send({ msisdn: phone, text: "YES" });
      expect(first.status).toBe(404);

      // Repeated spoofed requests remain unable to resolve the invitation.
      const second = await request(appMod.default)
        .post("/api/sms/sms-inbound")
        .type("form")
        .send({ msisdn: phone, text: "YES" });
      expect(second.status).toBe(404);

      // No link row can be created by the public SMS route.
      const links = await db
        .select()
        .from(doctorAccountLinks)
        .where(
          and(
            inArray(doctorAccountLinks.userIdLow, [userAId, userBId]),
            inArray(doctorAccountLinks.userIdHigh, [userAId, userBId])
          )
        );
      expect(links.length).toBe(0);
      const invite = await db.query.accountLinkInvites.findFirst({
        where: eq(accountLinkInvites.sentToPhone, phone),
      });
      expect(invite?.status).toBe("pending");
    } finally {
      await db.delete(accountLinkInvites).where(eq(accountLinkInvites.sentToPhone, phone));
      await db.delete(doctorAccountLinks).where(
        inArray(doctorAccountLinks.userIdLow, [userAId, userBId])
      );
      await db.delete(doctorAccountLinks).where(
        inArray(doctorAccountLinks.userIdHigh, [userAId, userBId])
      );
    }
  });

  it("POST /api/sms/sms-inbound is not mounted", async () => {
    const r = await request(appMod.default)
      .post("/api/sms/sms-inbound")
      .type("form")
      .send({ msisdn: "+19999999999", text: "YES" });

    expect(r.status).toBe(404);
  });
});
