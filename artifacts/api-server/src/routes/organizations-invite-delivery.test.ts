/**
 * Integration tests for invite email delivery tracking (regression guard).
 *
 * Silent-failure fix: invite create and resend used to swallow email send
 * failures and always return success. These tests pin the truthful contract:
 *  - create returns 201 with an `emailDelivery` outcome and records
 *    lastEmailAttemptAt / lastEmailStatus / lastEmailError on the invite row
 *  - raw provider errors are never exposed — they collapse to "send_failed"
 *  - resend returns 502 when the email fails, 409 when the recipient opted
 *    out (distinguishable), and 200 with emailDelivery on success
 *  - invite listings expose the delivery fields
 *
 * Skipped when DATABASE_URL is not configured. All inserted rows are removed
 * in afterAll so the suite is safe to run against a shared dev DB.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { inArray, eq } from "drizzle-orm";
import request from "supertest";
import * as path from "node:path";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(require("os").tmpdir(), "labtrax-test-media-invdel"),
  extractMediaFileName: () => null,
}));
vi.mock("../lib/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/mail.js")>();
  return {
    ...actual,
    sendInviteEmail: vi.fn().mockResolvedValue({ sent: true }),
  };
});

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function labBody(name: string) {
  return {
    type: "lab" as const,
    name,
    licenseNumber: `LIC-${randomBytes(3).toString("hex")}`,
    phone: "555-111-2222",
    billingEmail: "lab@example.com",
    addressLine1: "123 Test St",
  };
}

maybe("Invite email delivery tracking (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let authLib: typeof import("../lib/auth.js");
  let mailLib: typeof import("../lib/mail.js");

  const ownerId = rid("u");
  // Registered user who has opted out of invite emails.
  const optedOutUserId = rid("u");
  const optedOutEmail = `optout_${randomBytes(4).toString("hex")}@labtrax-test.com`;
  let orgId: string;
  const inviteIds: string[] = [];

  async function makeSession(userId: string): Promise<{ access: string }> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const refresh = authLib.signRefreshToken(userId, sessionId);
    const hash = createHash("sha256").update(refresh).digest("hex");
    await db.insert(userSessions).values({ id: sessionId, userId, tokenHash: hash, expiresAt });
    const access = authLib.signAccessToken(userId, sessionId);
    return { access };
  }

  function sendInviteEmailMock() {
    return vi.mocked(mailLib.sendInviteEmail);
  }

  async function createInvite(
    access: string,
    email: string
  ): Promise<request.Response> {
    const r = await request(appMod.default)
      .post(`/api/organizations/${orgId}/invites`)
      .set("Authorization", `Bearer ${access}`)
      .send({ email, roleToAssign: "user" });
    if (r.body?.data?.id) inviteIds.push(r.body.data.id);
    return r;
  }

  async function inviteRow(inviteId: string) {
    const { db, organizationInvites } = dbMod as any;
    const [row] = await db
      .select()
      .from(organizationInvites)
      .where(eq(organizationInvites.id, inviteId));
    return row;
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-invdel";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    authLib = await import("../lib/auth.js");
    mailLib = await import("../lib/mail.js");

    const { db, users } = dbMod as any;
    await db.insert(users).values({
      id: ownerId,
      username: `invdel_owner_${ownerId}`,
      password: "doesnotmatter",
    });
    await db.insert(users).values({
      id: optedOutUserId,
      username: `invdel_optout_${optedOutUserId}`,
      password: "doesnotmatter",
      email: optedOutEmail,
      emailPreferences: { orgInviteNotifications: false },
    });

    const { access } = await makeSession(ownerId);
    const r = await request(appMod.default)
      .post("/api/organizations")
      .set("Authorization", `Bearer ${access}`)
      .send(labBody(rid("InvDelLab")));
    expect(r.status).toBe(201);
    orgId = r.body.data.id;
  });

  beforeEach(() => {
    sendInviteEmailMock().mockReset();
    sendInviteEmailMock().mockResolvedValue({ sent: true });
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const {
      db,
      auditLogs,
      organizationInvites,
      userSessions,
      organizationMemberships,
      organizations,
      users,
    } = dbMod as any;
    if (inviteIds.length) {
      await db
        .delete(organizationInvites)
        .where(inArray(organizationInvites.id, inviteIds));
    }
    if (orgId) {
      await db.delete(auditLogs).where(eq(auditLogs.organizationId, orgId));
      await db
        .delete(organizationInvites)
        .where(eq(organizationInvites.labId, orgId));
      await db
        .delete(organizationMemberships)
        .where(eq(organizationMemberships.labId, orgId));
      await db.delete(organizations).where(eq(organizations.id, orgId));
    }
    const allUserIds = [ownerId, optedOutUserId];
    await db.delete(auditLogs).where(inArray(auditLogs.userId, allUserIds));
    await db.delete(userSessions).where(inArray(userSessions.userId, allUserIds));
    await db
      .delete(organizationMemberships)
      .where(inArray(organizationMemberships.userId, allUserIds));
    await db.delete(users).where(inArray(users.id, allUserIds));
  });

  // ── Create ────────────────────────────────────────────────────────────────

  it("create: returns emailDelivery sent=true and records the attempt", async () => {
    const { access } = await makeSession(ownerId);
    const r = await createInvite(access, `ok_${rid("e")}@labtrax-test.com`);

    expect(r.status).toBe(201);
    expect(r.body.data.emailDelivery).toEqual({ sent: true, status: "sent" });
    expect(sendInviteEmailMock()).toHaveBeenCalledTimes(1);

    const row = await inviteRow(r.body.data.id);
    expect(row.lastEmailStatus).toBe("sent");
    expect(row.lastEmailError).toBeNull();
    expect(row.lastEmailAttemptAt).toBeInstanceOf(Date);
  });

  it("create: reports a failed send truthfully without leaking raw errors", async () => {
    sendInviteEmailMock().mockResolvedValue({
      sent: false,
      reason: "535 5.7.8 BadCredentials super-secret-smtp-detail",
    });
    const { access } = await makeSession(ownerId);
    const r = await createInvite(access, `fail_${rid("e")}@labtrax-test.com`);

    expect(r.status).toBe(201); // invite is still created
    expect(r.body.data.emailDelivery).toEqual({
      sent: false,
      status: "failed",
      reason: "send_failed",
    });
    expect(JSON.stringify(r.body)).not.toContain("BadCredentials");

    const row = await inviteRow(r.body.data.id);
    expect(row.lastEmailStatus).toBe("failed");
    expect(row.lastEmailError).toBe("send_failed");
    expect(row.lastEmailAttemptAt).toBeInstanceOf(Date);
  });

  it("create: preserves known-safe failure reasons", async () => {
    sendInviteEmailMock().mockResolvedValue({
      sent: false,
      reason: "smtp_not_configured",
    });
    const { access } = await makeSession(ownerId);
    const r = await createInvite(access, `cfg_${rid("e")}@labtrax-test.com`);

    expect(r.status).toBe(201);
    expect(r.body.data.emailDelivery).toEqual({
      sent: false,
      status: "failed",
      reason: "smtp_not_configured",
    });
  });

  it("create: reports a thrown send error as failed, still 201", async () => {
    sendInviteEmailMock().mockRejectedValue(new Error("socket hang up"));
    const { access } = await makeSession(ownerId);
    const r = await createInvite(access, `boom_${rid("e")}@labtrax-test.com`);

    expect(r.status).toBe(201);
    expect(r.body.data.emailDelivery).toEqual({
      sent: false,
      status: "failed",
      reason: "send_failed",
    });
    expect(JSON.stringify(r.body)).not.toContain("socket hang up");
  });

  it("create: opted-out recipient is skipped, distinguishable from failure", async () => {
    const { access } = await makeSession(ownerId);
    const r = await createInvite(access, optedOutEmail);

    expect(r.status).toBe(201);
    expect(r.body.data.emailDelivery).toEqual({
      sent: false,
      status: "skipped",
      reason: "recipient_opted_out",
    });
    expect(sendInviteEmailMock()).not.toHaveBeenCalled();

    const row = await inviteRow(r.body.data.id);
    expect(row.lastEmailStatus).toBe("skipped");
    expect(row.lastEmailError).toBe("recipient_opted_out");
  });

  // ── Resend ────────────────────────────────────────────────────────────────

  it("resend: succeeds with emailDelivery and records the attempt", async () => {
    const { access } = await makeSession(ownerId);
    const created = await createInvite(access, `rs_${rid("e")}@labtrax-test.com`);
    const inviteId = created.body.data.id;

    const r = await request(appMod.default)
      .post(`/api/organizations/invites/${inviteId}/resend`)
      .set("Authorization", `Bearer ${access}`);

    expect(r.status).toBe(200);
    expect(r.body.data.emailDelivery).toEqual({ sent: true, status: "sent" });
    const row = await inviteRow(inviteId);
    expect(row.lastEmailStatus).toBe("sent");
  });

  it("resend: returns 502 with a safe reason when the send fails", async () => {
    const { access } = await makeSession(ownerId);
    const created = await createInvite(access, `rf_${rid("e")}@labtrax-test.com`);
    const inviteId = created.body.data.id;
    const tokenBefore = (await inviteRow(inviteId)).token;

    sendInviteEmailMock().mockResolvedValue({
      sent: false,
      reason: "451 4.3.0 provider-internal-detail",
    });
    const r = await request(appMod.default)
      .post(`/api/organizations/invites/${inviteId}/resend`)
      .set("Authorization", `Bearer ${access}`);

    expect(r.status).toBe(502);
    expect(r.body.ok).toBe(false);
    expect(r.body.message).toMatch(/could not be sent/i);
    expect(r.body.details).toEqual({ reason: "send_failed" });
    expect(JSON.stringify(r.body)).not.toContain("provider-internal-detail");

    // Failure is recorded and the invite is still pending (token rotated).
    const row = await inviteRow(inviteId);
    expect(row.status).toBe("pending");
    expect(row.lastEmailStatus).toBe("failed");
    expect(row.lastEmailError).toBe("send_failed");
    expect(row.token).not.toBe(tokenBefore);
  });

  it("resend: returns 409 when the recipient opted out (distinguishable)", async () => {
    const { access } = await makeSession(ownerId);
    // Reuse the opted-out invite created earlier, or create it if this test
    // file runs in isolation ordering.
    const { db, organizationInvites } = dbMod as any;
    const [existing] = await db
      .select()
      .from(organizationInvites)
      .where(eq(organizationInvites.email, optedOutEmail));
    const inviteId =
      existing?.id ?? (await createInvite(access, optedOutEmail)).body.data.id;

    const r = await request(appMod.default)
      .post(`/api/organizations/invites/${inviteId}/resend`)
      .set("Authorization", `Bearer ${access}`);

    expect(r.status).toBe(409);
    expect(r.body.ok).toBe(false);
    expect(r.body.details).toEqual({ reason: "recipient_opted_out" });
    expect(sendInviteEmailMock()).not.toHaveBeenCalled();
  });

  // ── Listings ──────────────────────────────────────────────────────────────

  it("org invites listing exposes the delivery fields", async () => {
    const { access } = await makeSession(ownerId);
    sendInviteEmailMock().mockResolvedValue({ sent: false, reason: "raw boom" });
    const created = await createInvite(access, `ls_${rid("e")}@labtrax-test.com`);
    const inviteId = created.body.data.id;

    const r = await request(appMod.default)
      .get(`/api/organizations/${orgId}/invites`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    const listed = r.body.data.find((i: any) => i.id === inviteId);
    expect(listed).toBeDefined();
    expect(listed.lastEmailStatus).toBe("failed");
    expect(listed.lastEmailError).toBe("send_failed");
    expect(listed.lastEmailAttemptAt).toBeTruthy();
  });

  // ── Automatic retry sweep ─────────────────────────────────────────────────

  async function backdateAttempt(inviteId: string, msAgo: number) {
    const { db, organizationInvites } = dbMod as any;
    await db
      .update(organizationInvites)
      .set({ lastEmailAttemptAt: new Date(Date.now() - msAgo) })
      .where(eq(organizationInvites.id, inviteId));
  }

  async function runSweep(inviteId: string): Promise<number> {
    const retryLib = await import("../lib/invite-email-retry.js");
    return retryLib.processDueInviteEmailRetries(new Date(), {
      onlyInviteIds: [inviteId],
    });
  }

  it("retry sweep: retries a transient failure and records a successful send", async () => {
    sendInviteEmailMock().mockResolvedValue({
      sent: false,
      reason: "451 transient smtp burp",
    });
    const { access } = await makeSession(ownerId);
    const created = await createInvite(access, `rt_${rid("e")}@labtrax-test.com`);
    const inviteId = created.body.data.id;
    expect((await inviteRow(inviteId)).lastEmailStatus).toBe("failed");

    // Backoff not yet elapsed → nothing happens.
    sendInviteEmailMock().mockClear();
    expect(await runSweep(inviteId)).toBe(0);
    expect(sendInviteEmailMock()).not.toHaveBeenCalled();

    // Backoff elapsed, SMTP recovered → retry succeeds.
    await backdateAttempt(inviteId, 6 * 60 * 1000);
    sendInviteEmailMock().mockResolvedValue({ sent: true });
    expect(await runSweep(inviteId)).toBe(1);
    expect(sendInviteEmailMock()).toHaveBeenCalledTimes(1);

    const row = await inviteRow(inviteId);
    expect(row.lastEmailStatus).toBe("sent");
    expect(row.lastEmailError).toBeNull();
    // Successful send resets the retry budget.
    expect(row.emailRetryCount).toBe(0);

    // A sent invite is never picked up again — no duplicate emails.
    sendInviteEmailMock().mockClear();
    await backdateAttempt(inviteId, 60 * 60 * 1000);
    expect(await runSweep(inviteId)).toBe(0);
    expect(sendInviteEmailMock()).not.toHaveBeenCalled();
  });

  it("retry sweep: records each failed retry and stops after the budget is spent", async () => {
    sendInviteEmailMock().mockResolvedValue({
      sent: false,
      reason: "socket hang up",
    });
    const { access } = await makeSession(ownerId);
    const created = await createInvite(access, `rb_${rid("e")}@labtrax-test.com`);
    const inviteId = created.body.data.id;

    // Retry 1 (fails again).
    await backdateAttempt(inviteId, 6 * 60 * 1000);
    const before1 = (await inviteRow(inviteId)).lastEmailAttemptAt;
    expect(await runSweep(inviteId)).toBe(1);
    let row = await inviteRow(inviteId);
    expect(row.emailRetryCount).toBe(1);
    expect(row.lastEmailStatus).toBe("failed");
    expect(row.lastEmailError).toBe("send_failed");
    expect(row.lastEmailAttemptAt.getTime()).toBeGreaterThan(
      before1.getTime()
    );

    // Second retry needs the longer backoff — 6 min is not enough.
    await backdateAttempt(inviteId, 6 * 60 * 1000);
    expect(await runSweep(inviteId)).toBe(0);

    // Retry 2 (fails again) after the longer backoff.
    await backdateAttempt(inviteId, 31 * 60 * 1000);
    expect(await runSweep(inviteId)).toBe(1);
    row = await inviteRow(inviteId);
    expect(row.emailRetryCount).toBe(2);
    expect(row.lastEmailStatus).toBe("failed");

    // Budget spent — no further retries no matter how much time passes.
    sendInviteEmailMock().mockClear();
    await backdateAttempt(inviteId, 24 * 60 * 60 * 1000);
    expect(await runSweep(inviteId)).toBe(0);
    expect(sendInviteEmailMock()).not.toHaveBeenCalled();

    // Manual resend restarts the budget.
    const r = await request(appMod.default)
      .post(`/api/organizations/invites/${inviteId}/resend`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(502); // still failing, but…
    row = await inviteRow(inviteId);
    expect(row.emailRetryCount).toBe(0); // …the auto-retry budget is fresh
  });

  it("retry sweep: never retries skipped or non-transient failures", async () => {
    const { access } = await makeSession(ownerId);

    // Skipped (recipient opted out) — never retried.
    const skipped = await createInvite(access, optedOutEmail).catch(() => null);
    // A pending invite for this email may already exist from earlier tests.
    const { db, organizationInvites } = dbMod as any;
    const [skippedRow] = await db
      .select()
      .from(organizationInvites)
      .where(eq(organizationInvites.email, optedOutEmail));
    const skippedId = skippedRow?.id ?? skipped?.body?.data?.id;
    expect(skippedId).toBeTruthy();
    await backdateAttempt(skippedId, 60 * 60 * 1000);
    sendInviteEmailMock().mockClear();
    expect(await runSweep(skippedId)).toBe(0);
    expect(sendInviteEmailMock()).not.toHaveBeenCalled();

    // Non-transient failure reason (undeliverable_domain) — never retried.
    sendInviteEmailMock().mockResolvedValue({
      sent: false,
      reason: "undeliverable_domain",
    });
    const created = await createInvite(access, `nd_${rid("e")}@labtrax-test.com`);
    const inviteId = created.body.data.id;
    expect((await inviteRow(inviteId)).lastEmailError).toBe(
      "undeliverable_domain"
    );
    await backdateAttempt(inviteId, 60 * 60 * 1000);
    sendInviteEmailMock().mockClear();
    expect(await runSweep(inviteId)).toBe(0);
    expect(sendInviteEmailMock()).not.toHaveBeenCalled();
    expect((await inviteRow(inviteId)).emailRetryCount).toBe(0);
  });

  it("retry sweep: skips an invite that was already claimed (no double send)", async () => {
    sendInviteEmailMock().mockResolvedValue({
      sent: false,
      reason: "boom transient",
    });
    const { access } = await makeSession(ownerId);
    const created = await createInvite(access, `cl_${rid("e")}@labtrax-test.com`);
    const inviteId = created.body.data.id;
    await backdateAttempt(inviteId, 6 * 60 * 1000);

    // Simulate a concurrent success between candidate selection and claim:
    // flip the row to sent before the sweep would claim it.
    const { db, organizationInvites } = dbMod as any;
    await db
      .update(organizationInvites)
      .set({ lastEmailStatus: "sent", lastEmailError: null })
      .where(eq(organizationInvites.id, inviteId));

    sendInviteEmailMock().mockClear();
    expect(await runSweep(inviteId)).toBe(0);
    expect(sendInviteEmailMock()).not.toHaveBeenCalled();
  });

  it("lab-team pendingInvites exposes the delivery fields", async () => {
    const { access } = await makeSession(ownerId);
    sendInviteEmailMock().mockResolvedValue({ sent: false, reason: "raw boom" });
    const created = await createInvite(access, `lt_${rid("e")}@labtrax-test.com`);
    const inviteId = created.body.data.id;

    const r = await request(appMod.default)
      .get("/api/auth/lab-team")
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    const pending = (r.body.pendingInvites ?? []).find(
      (i: any) => i.id === inviteId
    );
    expect(pending).toBeDefined();
    expect(pending.lastEmailStatus).toBe("failed");
    expect(pending.lastEmailError).toBe("send_failed");
    expect(pending.lastEmailAttemptAt).toBeTruthy();
  });
});
