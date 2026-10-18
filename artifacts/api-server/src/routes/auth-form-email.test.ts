import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { inArray } from "drizzle-orm";
import request from "supertest";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
}));
vi.mock("../lib/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/mail.js")>();
  return {
    ...actual,
    sendMail: vi.fn().mockResolvedValue({ sent: true }),
  };
});

const maybe = process.env["DATABASE_URL"] ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("POST /api/admin/auth-form-email billing access", () => {
  let dbMod: typeof import("@workspace/db");
  let app: import("express").Express;
  let signAccessToken: typeof import("../lib/auth.js").signAccessToken;

  const labId = rid("lab");
  const usersByRole = {
    owner: rid("uowner"),
    admin: rid("uadmin"),
    billing: rid("ubilling"),
    member: rid("umember"),
  } as const;
  const userIds = Object.values(usersByRole);

  async function makeToken(userId: string) {
    const sessionId = rid("sess");
    const token = signAccessToken(userId, sessionId);
    await dbMod.db.insert(dbMod.userSessions).values({
      id: sessionId,
      userId,
      tokenHash: createHash("sha256").update(token).digest("hex"),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    return token;
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] ??= "auth-form-email-test-secret";
    dbMod = await import("@workspace/db");
    app = (await import("../app.js")).default;
    signAccessToken = (await import("../lib/auth.js")).signAccessToken;

    await dbMod.db.insert(dbMod.users).values(
      userIds.map((id) => ({
        id,
        username: `${id}_user`,
        password: "x",
      })),
    );
    await dbMod.db.insert(dbMod.organizations).values({
      id: labId,
      type: "lab",
      name: "Authorization Email Test Lab",
    });
    await dbMod.db.insert(dbMod.organizationMemberships).values(
      Object.entries(usersByRole).map(([role, userId]) => ({
        id: rid("membership"),
        labId,
        userId,
        role,
        status: "active",
      })),
    );
  });

  afterAll(async () => {
    if (!dbMod) return;
    await dbMod.db
      .delete(dbMod.userSessions)
      .where(inArray(dbMod.userSessions.userId, userIds));
    await dbMod.db
      .delete(dbMod.organizationMemberships)
      .where(inArray(dbMod.organizationMemberships.userId, userIds));
    await dbMod.db.delete(dbMod.organizations).where(inArray(dbMod.organizations.id, [labId]));
    await dbMod.db.delete(dbMod.users).where(inArray(dbMod.users.id, userIds));
  });

  for (const role of ["owner", "admin", "billing"] as const) {
    it(`allows an active ${role} member to send the form`, async () => {
      const response = await request(app)
        .post("/api/admin/auth-form-email")
        .set("Authorization", `Bearer ${await makeToken(usersByRole[role])}`)
        .send({
          to: "provider@example.com",
          subject: "Card on File Authorization",
          body: "Authorization form",
        });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ ok: true });
    });
  }

  it("rejects a member without billing access", async () => {
    const response = await request(app)
      .post("/api/admin/auth-form-email")
      .set("Authorization", `Bearer ${await makeToken(usersByRole.member)}`)
      .send({
        to: "provider@example.com",
        subject: "Card on File Authorization",
        body: "Authorization form",
      });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "Billing access required." });
  });
});