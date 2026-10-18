/**
 * Integration tests for the verified "forgot username" flow (regression guard).
 *
 * Skipped when DATABASE_URL is not configured.  All inserted rows are removed
 * in afterAll so the suite is safe to run against a shared dev DB.
 *
 * Coverage:
 *  - POST /api/forgot-username — 200 neutral message for unknown email
 *    (no enumeration); no email sent
 *  - POST /api/forgot-username — known email: neutral response, email sent
 *    containing a view-username link and NEVER the username itself
 *  - POST /api/view-username — wrong password → 401; correct password
 *    reveals the username; the token is single-use (second call → 400)
 *  - POST /api/view-username — unknown/garbage token → 400 TOKEN_INVALID
 *  - POST /api/view-username — 5 wrong-password attempts invalidate the token
 *  - POST /api/view-username — missing token/password → 400
 *  - Legacy plain-text password accounts verify correctly
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
  caseMediaDir: path.join(require("os").tmpdir(), "labtrax-test-media-forgot-un"),
  extractMediaFileName: () => null,
}));

// Capture outbound mail so we can assert the email body never contains the
// username and does contain the secure view-username link.
const { sentMails } = vi.hoisted(() => ({
  sentMails: [] as Array<{ to: string; subject: string; html?: string; text?: string }>,
}));
vi.mock("../lib/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/mail.js")>();
  return {
    ...actual,
    sendMail: vi.fn(async (opts: any) => {
      sentMails.push(opts);
      return { ok: true };
    }),
  };
});

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function extractRecoveryToken(mail: { html?: string; text?: string }): string | null {
  const source = `${mail.html ?? ""}\n${mail.text ?? ""}`;
  const m = source.match(/username_token=([A-Za-z0-9_-]+)/);
  return m ? m[1]! : null;
}

maybe("Forgot username — verified recovery flow (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };

  const PASSWORD = "UnRecovery1!";
  let userId: string;
  let username: string;
  let email: string;

  let legacyUserId: string;
  let legacyUsername: string;
  let legacyEmail: string;
  const LEGACY_PASSWORD = "PlainLegacy1!";

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-forgot-un";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");

    const bcrypt = await import("bcryptjs");
    const { db, users } = dbMod as any;

    userId = rid("unrec");
    username = `un_${randomBytes(4).toString("hex")}`;
    email = `${userId}@example.com`;

    legacyUserId = rid("unleg");
    legacyUsername = `ul_${randomBytes(4).toString("hex")}`;
    legacyEmail = `${legacyUserId}@example.com`;

    await db.insert(users).values([
      {
        id: userId,
        username,
        password: await bcrypt.default.hash(PASSWORD, 4),
        email,
      },
      {
        // Legacy account whose password is still stored in plain text —
        // the view-username check must compare directly, like login does.
        id: legacyUserId,
        username: legacyUsername,
        password: LEGACY_PASSWORD,
        email: legacyEmail,
      },
    ]);
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const { db, users } = dbMod as any;
    await db.delete(users).where(inArray(users.id, [userId, legacyUserId]));
  });

  beforeEach(() => {
    sentMails.length = 0;
  });

  async function requestRecoveryToken(forEmail: string): Promise<string> {
    const r = await request(appMod.default)
      .post("/api/forgot-username")
      .send({ email: forEmail });
    expect(r.status).toBe(200);
    expect(sentMails.length).toBeGreaterThan(0);
    const token = extractRecoveryToken(sentMails[sentMails.length - 1]!);
    expect(token).toBeTruthy();
    return token!;
  }

  // ── POST /api/forgot-username ─────────────────────────────────────────────

  it("unknown email returns 200 with a neutral message and sends no email", async () => {
    const r = await request(appMod.default)
      .post("/api/forgot-username")
      .send({ email: "nobody-here@example.invalid" });

    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.message).toMatch(/if an account/i);
    expect(sentMails).toHaveLength(0);
  });

  it("missing email returns 400", async () => {
    const r = await request(appMod.default).post("/api/forgot-username").send({});
    expect(r.status).toBe(400);
  });

  it("known email sends a link email that never contains the username", async () => {
    const r = await request(appMod.default)
      .post("/api/forgot-username")
      .send({ email });

    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    // The response must be indistinguishable from the unknown-email case and
    // must never leak the username.
    expect(JSON.stringify(r.body)).not.toContain(username);

    expect(sentMails).toHaveLength(1);
    const mail = sentMails[0]!;
    expect(mail.to).toBe(email);
    // The username must never appear in the email body — only the link.
    expect(mail.html ?? "").not.toContain(username);
    expect(mail.text ?? "").not.toContain(username);
    expect(mail.html ?? "").toContain("/desktop/view-username?username_token=");
    expect(extractRecoveryToken(mail)).toBeTruthy();
  });

  // ── POST /api/view-username ───────────────────────────────────────────────

  it("wrong password returns 401; correct password reveals username; token is single-use", async () => {
    const token = await requestRecoveryToken(email);

    const wrong = await request(appMod.default)
      .post("/api/view-username")
      .send({ token, password: "NotThePassword1!" });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toMatch(/incorrect password/i);
    expect(JSON.stringify(wrong.body)).not.toContain(username);

    const ok = await request(appMod.default)
      .post("/api/view-username")
      .send({ token, password: PASSWORD });
    expect(ok.status).toBe(200);
    expect(ok.body.success).toBe(true);
    expect(ok.body.username).toBe(username);

    // Single-use: replaying the consumed token must fail.
    const replay = await request(appMod.default)
      .post("/api/view-username")
      .send({ token, password: PASSWORD });
    expect(replay.status).toBe(400);
    expect(replay.body.code).toBe("TOKEN_INVALID");
  });

  it("unknown token returns 400 TOKEN_INVALID", async () => {
    const r = await request(appMod.default)
      .post("/api/view-username")
      .send({ token: "definitely-not-a-real-token", password: PASSWORD });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("TOKEN_INVALID");
  });

  it("missing token or password returns 400", async () => {
    const noPassword = await request(appMod.default)
      .post("/api/view-username")
      .send({ token: "sometoken" });
    expect(noPassword.status).toBe(400);

    const noToken = await request(appMod.default)
      .post("/api/view-username")
      .send({ password: "whatever" });
    expect(noToken.status).toBe(400);
  });

  it("five wrong-password attempts invalidate the token", async () => {
    const token = await requestRecoveryToken(email);

    for (let attempt = 1; attempt <= 4; attempt++) {
      const r = await request(appMod.default)
        .post("/api/view-username")
        .send({ token, password: `Wrong${attempt}!` });
      expect(r.status).toBe(401);
    }

    // Fifth failure burns the token.
    const fifth = await request(appMod.default)
      .post("/api/view-username")
      .send({ token, password: "Wrong5!" });
    expect(fifth.status).toBe(400);
    expect(fifth.body.code).toBe("TOKEN_INVALID");

    // Even the correct password can no longer redeem it.
    const after = await request(appMod.default)
      .post("/api/view-username")
      .send({ token, password: PASSWORD });
    expect(after.status).toBe(400);
    expect(after.body.code).toBe("TOKEN_INVALID");
  });

  it("legacy plain-text password account verifies and reveals its username", async () => {
    const token = await requestRecoveryToken(legacyEmail);

    const wrong = await request(appMod.default)
      .post("/api/view-username")
      .send({ token, password: "NotIt1!" });
    expect(wrong.status).toBe(401);

    const ok = await request(appMod.default)
      .post("/api/view-username")
      .send({ token, password: LEGACY_PASSWORD });
    expect(ok.status).toBe(200);
    expect(ok.body.username).toBe(legacyUsername);
  });
});
