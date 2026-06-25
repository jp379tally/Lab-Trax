/**
 * Regression test: DELETE /api/legacy/cases/:caseId writes an audit entry.
 *
 * The single-case legacy delete endpoint routes through softDeleteLegacyCases,
 * which sets deleted_at + deleted_by AND writes one "case_soft_deleted" audit
 * row (metadataJson.legacy:true) per case, matching the canonical case-delete
 * path. The existing automated coverage for that audit write only exercises the
 * bulk-delete path (cases-bulk-delete.test.ts); this suite locks in the
 * single-case endpoint so a future refactor can't silently drop the audit row.
 *
 * Skipped when DATABASE_URL is not configured (same convention as sibling
 * legacy-case DB suites). Each test owns its rows; afterAll sweeps the rest so
 * the suite is safe against a shared dev DB.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import request from "supertest";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(os.tmpdir(), "labtrax-test-media-single-delete"),
  extractMediaFileName: () => null,
  extractMediaFilenamesFromText: () => [],
}));

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

const SHOULD_RUN_DB = !!process.env["DATABASE_URL"];
const maybeDb = SHOULD_RUN_DB ? describe : describe.skip;

maybeDb("DELETE /api/legacy/cases/:caseId — audit entry (DB suite)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let auth: typeof import("../lib/auth.js");

  const labOrgId = rid("lab");
  const userId = rid("uowner");
  let token = "";

  async function makeSession(uid: string): Promise<string> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const t = auth.signAccessToken(uid, sessionId);
    const hash = createHash("sha256").update(t).digest("hex");
    await db
      .insert(userSessions)
      .values({ id: sessionId, userId: uid, tokenHash: hash, expiresAt });
    return t;
  }

  async function insertLegacy(): Promise<string> {
    const { db, labCases } = dbMod as any;
    const id = rid("legacy");
    await db.insert(labCases).values({
      id,
      ownerId: userId,
      organizationId: labOrgId,
      caseData: JSON.stringify({
        caseNumber: "LC-001",
        patientName: "Legacy Pat",
        status: "RECEIVED",
      }),
    });
    return id;
  }

  beforeAll(async () => {
    fs.mkdirSync(path.join(os.tmpdir(), "labtrax-test-media-single-delete"), {
      recursive: true,
    });
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-single-delete";

    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    auth = await import("../lib/auth.js");

    const { db, organizations, users, organizationMemberships } = dbMod as any;

    await db
      .insert(users)
      .values([{ id: userId, username: rid("user"), password: "testpass" }]);
    await db
      .insert(organizations)
      .values([{ id: labOrgId, type: "lab", name: "Single Delete Test Lab" }]);
    await db.insert(organizationMemberships).values([
      {
        id: rid("m"),
        labId: labOrgId,
        userId,
        role: "admin",
        status: "active",
      },
    ]);

    token = await makeSession(userId);
  });

  // Refresh session token before every test so a concurrent user_sessions wipe
  // does not invalidate the shared token mid-suite.
  beforeEach(async () => {
    token = await makeSession(userId);
  });

  afterAll(async () => {
    if (!SHOULD_RUN_DB) return;
    const {
      db,
      organizations,
      users,
      organizationMemberships,
      userSessions,
      labCases,
      auditLogs,
    } = dbMod as any;
    await db.delete(auditLogs).where(eq(auditLogs.organizationId, labOrgId));
    await db.delete(labCases).where(eq(labCases.organizationId, labOrgId));
    await db
      .delete(organizationMemberships)
      .where(eq(organizationMemberships.userId, userId));
    await db.delete(userSessions).where(eq(userSessions.userId, userId));
    await db.delete(organizations).where(eq(organizations.id, labOrgId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("soft-deletes the legacy case and writes a case_soft_deleted audit row", async () => {
    const { db, labCases, auditLogs } = dbMod as any;
    const caseId = await insertLegacy();

    const res = await request(appMod.default)
      .delete(`/api/legacy/cases/${caseId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.success).toBe(true);

    // Soft-delete: row still exists with deletedAt + deletedBy set.
    const [row] = await db
      .select({
        id: labCases.id,
        deletedAt: labCases.deletedAt,
        deletedBy: labCases.deletedBy,
      })
      .from(labCases)
      .where(eq(labCases.id, caseId));
    expect(row).toBeTruthy();
    expect(row.deletedAt).not.toBeNull();
    expect(row.deletedBy).toBeTruthy();

    // Audit entry: case_soft_deleted with legacy:true.
    const auditRows = await db
      .select({
        action: auditLogs.action,
        entityType: auditLogs.entityType,
        entityId: auditLogs.entityId,
        userId: auditLogs.userId,
        metadataJson: auditLogs.metadataJson,
      })
      .from(auditLogs)
      .where(eq(auditLogs.entityId, caseId));
    const softDeleteEntry = auditRows.find(
      (x: any) => x.action === "case_soft_deleted",
    );
    expect(
      softDeleteEntry,
      "expected a case_soft_deleted audit entry",
    ).toBeTruthy();
    expect(softDeleteEntry.entityType).toBe("case");
    expect(softDeleteEntry.userId).toBe(userId);
    expect(softDeleteEntry.metadataJson?.legacy).toBe(true);
  });
});
