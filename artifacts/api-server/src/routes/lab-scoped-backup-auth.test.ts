/**
 * Lab-scoped backup authorization and active-lab selection.
 * Uses isolated membership fixtures in the shared development database.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Express } from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const streamMock = vi.hoisted(() => vi.fn(async ({ response }: { response: any }) => {
  response.status(200);
  response.setHeader("Content-Type", "application/octet-stream");
  response.end(Buffer.from("scoped-test-download"));
}));

vi.mock("../lib/lab-scoped-backup.js", () => ({
  streamLabScopedBackupDownload: streamMock,
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/statements.js")>()),
  startStatementScheduler: vi.fn(),
}));

const SHOULD_RUN = Boolean(process.env.DATABASE_URL);
const maybe = SHOULD_RUN ? describe : describe.skip;
const rid = (prefix: string) => `${prefix}_${randomBytes(8).toString("hex")}`;

maybe("lab-scoped backup authorization (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let authMod: typeof import("../lib/auth.js");
  let app: Express;
  const labA = rid("lab_backup_a");
  const labB = rid("lab_backup_b");
  const ownerA = rid("lab_backup_owner_a");
  const adminB = rid("lab_backup_admin_b");
  const memberA = rid("lab_backup_member_a");
  const inactiveOwner = rid("lab_backup_inactive_owner");
  const multiLabAdmin = rid("lab_backup_multi_admin");
  const userIds = [ownerA, adminB, memberA, inactiveOwner, multiLabAdmin];
  const membershipIds: string[] = [];
  const sessionIds: string[] = [];

  async function tokenFor(userId: string): Promise<string> {
    const sessionId = rid("lab_backup_session");
    const token = authMod.signAccessToken(userId, sessionId);
    await dbMod.db.insert(dbMod.userSessions).values({
      id: sessionId,
      userId,
      tokenHash: createHash("sha256").update(token).digest("hex"),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    sessionIds.push(sessionId);
    return token;
  }

  async function addMembership(
    userId: string,
    labId: string,
    role: string,
    status = "active",
  ) {
    const id = rid("lab_backup_membership");
    await dbMod.db.insert(dbMod.organizationMemberships).values({
      id,
      userId,
      labId,
      role,
      status,
    });
    membershipIds.push(id);
  }

  beforeAll(async () => {
    process.env.JWT_SECRET ??= "lab-scoped-backup-auth-test-secret";
    dbMod = await import("@workspace/db");
    authMod = await import("../lib/auth.js");
    app = (await import("../app.js")).default as Express;
    await (await import("./index.js")).labtraxRoutesReady;

    await dbMod.db.insert(dbMod.users).values(userIds.map((id) => ({
      id,
      username: id,
      password: "test-password-hash",
    })));
    await dbMod.db.insert(dbMod.organizations).values([
      { id: labA, type: "lab", name: "Backup Test Lab A" },
      { id: labB, type: "lab", name: "Backup Test Lab B" },
    ]);
    await addMembership(ownerA, labA, "owner");
    await addMembership(adminB, labB, "admin");
    await addMembership(memberA, labA, "member");
    await addMembership(inactiveOwner, labA, "owner", "inactive");
    await addMembership(multiLabAdmin, labA, "admin");
    await addMembership(multiLabAdmin, labB, "owner");
  });

  afterAll(async () => {
    if (!dbMod) return;
    streamMock.mockClear();
    await dbMod.db.delete(dbMod.userSessions).where(
      (await import("drizzle-orm")).inArray(dbMod.userSessions.id, sessionIds),
    );
    await dbMod.db.delete(dbMod.organizationMemberships).where(
      (await import("drizzle-orm")).inArray(dbMod.organizationMemberships.id, membershipIds),
    );
    await dbMod.db.delete(dbMod.users).where(
      (await import("drizzle-orm")).inArray(dbMod.users.id, userIds),
    );
    await dbMod.db.delete(dbMod.organizations).where(
      (await import("drizzle-orm")).inArray(dbMod.organizations.id, [labA, labB]),
    );
  });

  it("denies unauthenticated and non-admin members", async () => {
    const anonymous = await request(app).get("/api/lab/backup/generate");
    expect(anonymous.status).toBe(401);

    const token = await tokenFor(memberA);
    const member = await request(app)
      .get(`/api/lab/backup/generate?labOrganizationId=${labA}`)
      .set("Authorization", `Bearer ${token}`);
    expect(member.status).toBe(403);
    expect(streamMock).not.toHaveBeenCalled();
  });

  it("denies inactive memberships and attempts to select another lab", async () => {
    const inactiveToken = await tokenFor(inactiveOwner);
    const inactive = await request(app)
      .get(`/api/lab/backup/generate?labOrganizationId=${labA}`)
      .set("Authorization", `Bearer ${inactiveToken}`);
    expect(inactive.status).toBe(403);

    const ownerToken = await tokenFor(ownerA);
    const crossLab = await request(app)
      .get(`/api/lab/backup/generate?labOrganizationId=${labB}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(crossLab.status).toBe(403);
    expect(streamMock).not.toHaveBeenCalled();
  });

  it("requires selection for multiple eligible labs and resolves the selected membership server-side", async () => {
    const token = await tokenFor(multiLabAdmin);
    const missingSelection = await request(app)
      .get("/api/lab/backup/generate")
      .set("Authorization", `Bearer ${token}`);
    expect(missingSelection.status).toBe(400);

    const selected = await request(app)
      .get(`/api/lab/backup/generate?labOrganizationId=${labA}`)
      .set("Authorization", `Bearer ${token}`);
    expect(selected.status).toBe(200);
    expect(selected.body.toString()).toBe("scoped-test-download");
    expect(streamMock).toHaveBeenCalledWith(expect.objectContaining({
      labId: labA,
      labName: "Backup Test Lab A",
      userId: multiLabAdmin,
    }));
    expect(streamMock).toHaveBeenCalledTimes(1);
  });
});
