/**
 * Integration test: permission grant → guarded action succeeds → revoke grant → 403.
 *
 * Verifies the end-to-end flow that hasCapability() + the PUT
 * /members/:id/permissions endpoint together enforce: once a capability grant
 * is removed mid-session the next action gated by that capability must fail
 * with a 403.
 *
 * The "guarded action" is a small in-test Express route that calls
 * hasCapability() directly against the real database and returns 200 or 403
 * based on the result.  This isolates the capability-check logic without
 * requiring a production route that already calls hasCapability().
 *
 * Skipped when DATABASE_URL is not set.  All rows are removed in afterAll.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes, createHash } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import * as path from "node:path";
import * as os from "node:os";
import request from "supertest";
import express, { json } from "express";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(os.tmpdir(), "labtrax-test-media-perm-gate"),
  extractMediaFileName: () => null,
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

maybe("Permission grant → revocation mid-session (hasCapability gate)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let authLib: typeof import("../lib/auth.js");
  let hasCapabilityFn: typeof import("../lib/rbac.js").hasCapability;

  const ownerId = rid("u");
  const memberId = rid("u");
  const labOrgId = rid("lab");
  const memberEmail = `${memberId}@test.local`;

  let ownerMembershipId: string;
  let userMembershipId: string;
  let permDefId: string;
  let teamManagementPermDefId: string;

  /**
   * Create a short-lived bearer token for `uid` backed by a real session row.
   */
  async function makeSession(uid: string): Promise<string> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const refresh = authLib.signRefreshToken(uid, sessionId);
    const tokenHash = createHash("sha256").update(refresh).digest("hex");
    await db.insert(userSessions).values({
      id: sessionId,
      userId: uid,
      tokenHash,
      expiresAt,
    });
    return authLib.signAccessToken(uid, sessionId);
  }

  /**
   * Returns a minimal Express app whose single route calls hasCapability() for
   * the test member and responds 200 on success or 403 when the capability is
   * absent.  Creating a fresh app per-call ensures no caching between checks.
   */
  function makeGuardedApp() {
    const app = express();
    app.use(json());
    app.get("/guarded", async (_req, res) => {
      try {
        const allowed = await hasCapabilityFn(
          memberId,
          labOrgId,
          "view_financial_reports"
        );
        if (!allowed) {
          res.status(403).json({ error: "Capability required." });
          return;
        }
        res.status(200).json({ ok: true });
      } catch (err: any) {
        res.status(500).json({ error: err.message ?? "Unknown error" });
      }
    });
    return app;
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-perm-gate";

    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    authLib = await import("../lib/auth.js");
    const rbacLib = await import("../lib/rbac.js");
    hasCapabilityFn = rbacLib.hasCapability;

    const { db, users, organizations, organizationMemberships } = dbMod as any;

    await db.insert(users).values([
      {
        id: ownerId,
        username: `pgowner_${ownerId}`,
        password: "doesnotmatter",
      },
      {
        id: memberId,
        username: `pgmember_${memberId}`,
        password: "doesnotmatter",
        email: memberEmail,
      },
    ]);

    await db
      .insert(organizations)
      .values({ id: labOrgId, type: "lab", name: rid("PermGateTestLab") });

    ownerMembershipId = rid("mem");
    userMembershipId = rid("mem");

    await db.insert(organizationMemberships).values([
      {
        id: ownerMembershipId,
        labId: labOrgId,
        userId: ownerId,
        role: "owner",
        status: "active",
        approvedByUserId: ownerId,
        joinedAt: new Date(),
      },
      {
        id: userMembershipId,
        labId: labOrgId,
        userId: memberId,
        role: "user",
        status: "active",
        approvedByUserId: ownerId,
        joinedAt: new Date(),
      },
    ]);

    const ownerToken = await makeSession(ownerId);

    // Create a permission definition for the view_financial_reports capability.
    const defRes = await request(appMod.default)
      .post(`/api/organizations/${labOrgId}/permission-definitions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        name: "View Financial Reports",
        capabilityKey: "view_financial_reports",
      });

    if (defRes.status !== 200) {
      throw new Error(
        `beforeAll: POST permission-definitions failed ${defRes.status}: ${JSON.stringify(defRes.body)}`
      );
    }
    permDefId = defRes.body.data.id;

    const teamManagementDefRes = await request(appMod.default)
      .post(`/api/organizations/${labOrgId}/permission-definitions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        name: "Manage Team Members",
        capabilityKey: "manage_team_members",
      });
    if (teamManagementDefRes.status !== 200) {
      throw new Error(
        `beforeAll: POST team-management permission definition failed ${teamManagementDefRes.status}: ${JSON.stringify(teamManagementDefRes.body)}`
      );
    }
    teamManagementPermDefId = teamManagementDefRes.body.data.id;

    // Grant the capabilities to the non-owner member.
    const grantRes = await request(appMod.default)
      .put(
        `/api/organizations/${labOrgId}/members/${userMembershipId}/permissions`
      )
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ permissionDefinitionIds: [permDefId, teamManagementPermDefId] });

    if (grantRes.status !== 200) {
      throw new Error(
        `beforeAll: PUT member permissions failed ${grantRes.status}: ${JSON.stringify(grantRes.body)}`
      );
    }
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;

    const {
      db,
      labMemberPermissions,
      labPermissionDefinitions,
      userSessions,
      organizationMemberships,
      organizations,
      users,
    } = dbMod as any;

    await db
      .delete(labMemberPermissions)
      .where(eq(labMemberPermissions.membershipId, userMembershipId))
      .catch(() => {});

    const permissionDefinitionIds = [permDefId, teamManagementPermDefId].filter(Boolean);
    if (permissionDefinitionIds.length > 0) {
      await db
        .delete(labPermissionDefinitions)
        .where(inArray(labPermissionDefinitions.id, permissionDefinitionIds))
        .catch(() => {});
    }

    await db
      .delete(userSessions)
      .where(inArray(userSessions.userId, [ownerId, memberId]));

    await db
      .delete(organizationMemberships)
      .where(inArray(organizationMemberships.userId, [ownerId, memberId]));

    await db.delete(organizations).where(eq(organizations.id, labOrgId));

    await db.delete(users).where(inArray(users.id, [ownerId, memberId]));
  });

  it("guarded action returns 200 when the capability grant is active", async () => {
    const guardedApp = makeGuardedApp();
    const res = await request(guardedApp).get("/guarded");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
  });

  it("prevents a team-management capability holder from inviting their own account as owner", async () => {
    const memberToken = await makeSession(memberId);
    const res = await request(appMod.default)
      .post(`/api/organizations/${labOrgId}/invites`)
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ email: memberEmail, roleToAssign: "owner", expiresInDays: 1 });

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toMatch(/role above your own/i);

    const membership = await dbMod.db.query.organizationMemberships.findFirst({
      where: eq(dbMod.organizationMemberships.id, userMembershipId),
    });
    expect(membership).toMatchObject({ role: "user" });
  });

  it("PUT /members/:id/permissions with empty array revokes all grants", async () => {
    const ownerToken = await makeSession(ownerId);
    const res = await request(appMod.default)
      .put(
        `/api/organizations/${labOrgId}/members/${userMembershipId}/permissions`
      )
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ permissionDefinitionIds: [] });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      membershipId: userMembershipId,
      permissionDefinitionIds: [],
    });
  });

  it("guarded action returns 403 after the grant is revoked", async () => {
    const guardedApp = makeGuardedApp();
    const res = await request(guardedApp).get("/guarded");
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "Capability required." });
  });
});
