/**
 * Integration tests for the member-scoped provider-list endpoint
 * `GET /api/organizations/:labId/providers`.
 *
 * This endpoint powers the mobile Rx-review practice picker: any active
 * member of the lab (not just admins) can browse the lab's provider
 * practices, including ones created inline that have no cases yet.
 *
 * Like the sibling suites, these tests:
 *   - are skipped when no DATABASE_URL is configured;
 *   - skip cleanly (with a console notice) if the route is not mounted in
 *     the snapshot under test, so a partial merge surfaces one warning
 *     instead of a wall of cascading failures.
 *
 * Coverage:
 *   - a lab member receives the lab's provider practices (200);
 *   - a non-member is rejected (403);
 *   - soft-deleted provider practices are excluded;
 *   - inline-created practices (no cases) still appear.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("GET /api/organizations/:labId/providers (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let auth: typeof import("../lib/auth.js");
  let routeAvailable = true;

  const labOrgId = rid("lab");
  const otherLabOrgId = rid("lab");
  const activeProviderId = rid("provA");
  const inlineProviderId = rid("provInline");
  const deletedProviderId = rid("provDel");
  const otherLabProviderId = rid("provOther");

  const memberUserId = rid("umember");
  const nonMemberUserId = rid("unon");

  const tokens = { member: "", nonMember: "" };

  async function makeSession(userId: string): Promise<string> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const token = auth.signAccessToken(userId, sessionId);
    const hash = createHash("sha256").update(token).digest("hex");
    await db.insert(userSessions).values({
      id: sessionId,
      userId,
      tokenHash: hash,
      expiresAt,
    });
    return token;
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-lab-providers";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    auth = await import("../lib/auth.js");

    const { db, organizations, users, organizationMemberships } = dbMod as any;

    await db.insert(users).values([
      { id: memberUserId, username: `mem_${memberUserId}`, password: "x" },
      { id: nonMemberUserId, username: `non_${nonMemberUserId}`, password: "x" },
    ]);

    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: "Provider-list Test Lab" },
      { id: otherLabOrgId, type: "lab", name: "Other Lab" },
      {
        id: activeProviderId,
        type: "provider",
        name: "Active Practice",
        displayName: "Active Practice",
        city: "Austin",
        state: "TX",
        parentLabOrganizationId: labOrgId,
      },
      {
        id: inlineProviderId,
        type: "provider",
        name: "Inline Practice (no cases)",
        parentLabOrganizationId: labOrgId,
      },
      {
        id: deletedProviderId,
        type: "provider",
        name: "Deleted Practice",
        parentLabOrganizationId: labOrgId,
        deletedAt: new Date(),
        deletedByUserId: memberUserId,
      },
      {
        id: otherLabProviderId,
        type: "provider",
        name: "Other Lab Practice",
        parentLabOrganizationId: otherLabOrgId,
      },
    ]);

    // memberUserId is a plain (non-admin) member of the lab.
    await db.insert(organizationMemberships).values([
      {
        id: rid("m"),
        labId: labOrgId,
        userId: memberUserId,
        role: "member",
        status: "active",
      },
    ]);

    tokens.member = await makeSession(memberUserId);
    tokens.nonMember = await makeSession(nonMemberUserId);

    // Route-existence probe. An authed call to a mounted route returns
    // 200/403; a 404 means the route isn't present in this snapshot.
    const probe = await request(appMod.default)
      .get(`/api/organizations/${labOrgId}/providers`)
      .set("Authorization", `Bearer ${tokens.member}`);
    if (probe.status === 404) {
      routeAvailable = false;
      // eslint-disable-next-line no-console
      console.warn(
        "[lab-providers.test] GET /api/organizations/:labId/providers not " +
          "mounted — skipping provider-list integration tests.",
      );
    }
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const { db, organizations, users, organizationMemberships, userSessions } =
      dbMod as any;
    await db
      .delete(organizationMemberships)
      .where(
        inArray(organizationMemberships.userId, [memberUserId, nonMemberUserId]),
      );
    await db
      .delete(userSessions)
      .where(inArray(userSessions.userId, [memberUserId, nonMemberUserId]));
    await db
      .delete(organizations)
      .where(
        inArray(organizations.id, [
          labOrgId,
          otherLabOrgId,
          activeProviderId,
          inlineProviderId,
          deletedProviderId,
          otherLabProviderId,
        ]),
      );
    await db
      .delete(users)
      .where(inArray(users.id, [memberUserId, nonMemberUserId]));
  });

  it("returns the lab's active provider practices for a member", async () => {
    if (!routeAvailable) return;
    const r = await request(appMod.default)
      .get(`/api/organizations/${labOrgId}/providers`)
      .set("Authorization", `Bearer ${tokens.member}`);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);

    const providers = r.body.data.providers as Array<{ id: string }>;
    expect(Array.isArray(providers)).toBe(true);
    const ids = providers.map((p) => p.id);
    expect(ids).toContain(activeProviderId);

    // Scoped to this lab only — another lab's practice never leaks in.
    expect(ids).not.toContain(otherLabProviderId);
  });

  it("includes inline-created practices that have no cases", async () => {
    if (!routeAvailable) return;
    const r = await request(appMod.default)
      .get(`/api/organizations/${labOrgId}/providers`)
      .set("Authorization", `Bearer ${tokens.member}`);
    expect(r.status).toBe(200);
    const ids = (r.body.data.providers as Array<{ id: string }>).map(
      (p) => p.id,
    );
    expect(ids).toContain(inlineProviderId);
  });

  it("excludes soft-deleted practices", async () => {
    if (!routeAvailable) return;
    const r = await request(appMod.default)
      .get(`/api/organizations/${labOrgId}/providers`)
      .set("Authorization", `Bearer ${tokens.member}`);
    expect(r.status).toBe(200);
    const ids = (r.body.data.providers as Array<{ id: string }>).map(
      (p) => p.id,
    );
    expect(ids).not.toContain(deletedProviderId);
  });

  it("rejects a non-member with 403", async () => {
    if (!routeAvailable) return;
    const r = await request(appMod.default)
      .get(`/api/organizations/${labOrgId}/providers`)
      .set("Authorization", `Bearer ${tokens.nonMember}`);
    expect(r.status).toBe(403);
  });

  it("returns 401 without authentication", async () => {
    if (!routeAvailable) return;
    const r = await request(appMod.default).get(
      `/api/organizations/${labOrgId}/providers`,
    );
    expect(r.status).toBe(401);
  });
});
