/**
 * Regression coverage for the platform-admin boundary on vendor-link backfills.
 *
 * A tenant administrator can have users.role="admin", but must still provide
 * platform-admin unlock credentials before previewing or changing all-lab
 * bookkeeping data.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import request from "supertest";
import * as path from "node:path";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(require("os").tmpdir(), "labtrax-test-vendor-backfill-auth"),
  extractMediaFileName: () => null,
}));

const SHOULD_RUN_DB = !!process.env["DATABASE_URL"];
const maybeDb = SHOULD_RUN_DB ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybeDb("vendor-link backfill authorization (DB integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let auth: typeof import("../lib/auth.js");
  const userId = rid("backfill-admin");
  const labId = rid("backfill-lab");
  let token = "";

  beforeAll(async () => {
    process.env["JWT_SECRET"] ??= "labtrax-test-secret-vendor-backfill-auth";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    auth = await import("../lib/auth.js");

    const { db, users, organizations, organizationMemberships } = dbMod as any;
    await db.insert(users).values({
      id: userId,
      username: rid("tenant-admin"),
      password: "testpass",
      role: "admin",
    });
    await db.insert(organizations).values({
      id: labId,
      type: "lab",
      name: "Vendor Backfill Authorization Test Lab",
    });
    await db.insert(organizationMemberships).values({
      id: rid("membership"),
      labId,
      userId,
      role: "admin",
      status: "active",
    });

    const sessionId = rid("session");
    const accessToken = auth.signAccessToken(userId, sessionId);
    const tokenHash = createHash("sha256").update(accessToken).digest("hex");
    await db.insert(dbMod.userSessions).values({
      id: sessionId,
      userId,
      tokenHash,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    token = accessToken;
  });

  afterAll(async () => {
    if (!SHOULD_RUN_DB) return;
    const { db, auditLogs, organizationMemberships, userSessions, organizations, users } =
      dbMod as any;
    await db.delete(auditLogs).where(eq(auditLogs.userId, userId));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.userId, userId));
    await db.delete(userSessions).where(eq(userSessions.userId, userId));
    await db.delete(organizations).where(eq(organizations.id, labId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("blocks a tenant admin from reading cross-lab backfill preview data", async () => {
    const response = await request(appMod.default)
      .get("/api/admin/finance/vendor-link-backfill/preview")
      .set("Authorization", `Bearer ${token}`);

    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(response.body.error).toMatch(/platform admin unlock/i);
  });

  it("blocks a tenant admin from applying cross-lab vendor attribution changes", async () => {
    const response = await request(appMod.default)
      .post("/api/admin/finance/vendor-link-backfill/run")
      .set("Authorization", `Bearer ${token}`)
      .send({ applyChanges: true });

    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(response.body.error).toMatch(/platform admin unlock/i);
  });
});