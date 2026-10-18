/**
 * GET /admin/users/:id/linked-labs — regression guard (Task #2457).
 *
 * Powers the "Linked labs" section of the Accounts directory's user detail
 * drawer. Gated by platform-admin secret. Returns every other lab a user's
 * doctor identity is connected to via a confirmed doctor_account_links row
 * ("active") or an outstanding account_link_invites row in either direction
 * ("pending"). Skipped when DATABASE_URL is not set.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import request from "supertest";
import * as path from "node:path";
import { inArray } from "drizzle-orm";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(require("os").tmpdir(), "labtrax-test-media-linked-labs"),
  extractMediaFileName: () => null,
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

const PLATFORM_ADMIN_SECRET = "linked-labs-test-secret";
process.env["PLATFORM_ADMIN_SECRET"] = PLATFORM_ADMIN_SECRET;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("GET /admin/users/:id/linked-labs", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };

  const createdUserIds: string[] = [];
  const createdOrgIds: string[] = [];
  const createdMembershipIds: string[] = [];
  const createdLinkIds: string[] = [];
  const createdInviteIds: string[] = [];

  beforeAll(async () => {
    process.env["JWT_SECRET"] = process.env["JWT_SECRET"] ?? "labtrax-test-secret-linked-labs";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    await (await import("./index.js")).labtraxRoutesReady;
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const {
      db,
      doctorAccountLinks,
      accountLinkInvites,
      organizationMemberships,
      organizations,
      users,
    } = dbMod as any;
    if (createdLinkIds.length) {
      await db.delete(doctorAccountLinks).where(inArray(doctorAccountLinks.id, createdLinkIds));
    }
    if (createdInviteIds.length) {
      await db.delete(accountLinkInvites).where(inArray(accountLinkInvites.id, createdInviteIds));
    }
    if (createdMembershipIds.length) {
      await db
        .delete(organizationMemberships)
        .where(inArray(organizationMemberships.id, createdMembershipIds));
    }
    if (createdOrgIds.length) {
      await db.delete(organizations).where(inArray(organizations.id, createdOrgIds));
    }
    if (createdUserIds.length) {
      await db.delete(users).where(inArray(users.id, createdUserIds));
    }
  });

  it("rejects without admin credentials (401)", async () => {
    const res = await request(appMod.default).get("/api/admin/users/some-id/linked-labs");
    expect(res.status).toBe(401);
  });

  it("returns 404 for a non-existent user", async () => {
    const res = await request(appMod.default)
      .get("/api/admin/users/nonexistent-uuid/linked-labs")
      .set("x-platform-admin-secret", PLATFORM_ADMIN_SECRET);
    expect(res.status).toBe(404);
    expect(res.body.error).toContain("not found");
  });

  it("returns an empty list for a user with no links", async () => {
    const userId = rid("u");
    const { db, users } = dbMod as any;
    await db.insert(users).values({
      id: userId,
      username: `nolinks_${userId}`,
      password: "doesnotmatter",
    });
    createdUserIds.push(userId);

    const res = await request(appMod.default)
      .get(`/api/admin/users/${userId}/linked-labs`)
      .set("x-platform-admin-secret", PLATFORM_ADMIN_SECRET);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.linkedLabs).toEqual([]);
  });

  it("reports an accepted link's lab as active and a pending invite's lab as pending", async () => {
    const { db, users, organizations, organizationMemberships, doctorAccountLinks, accountLinkInvites } =
      dbMod as any;

    const mainUserId = rid("u");
    const activeLinkedUserId = rid("u");
    const pendingLinkedUserId = rid("u");
    createdUserIds.push(mainUserId, activeLinkedUserId, pendingLinkedUserId);

    await db.insert(users).values([
      { id: mainUserId, username: `main_${mainUserId}`, password: "x" },
      { id: activeLinkedUserId, username: `active_${activeLinkedUserId}`, password: "x" },
      { id: pendingLinkedUserId, username: `pending_${pendingLinkedUserId}`, password: "x" },
    ]);

    const activeLabId = rid("lab");
    const pendingLabId = rid("lab");
    createdOrgIds.push(activeLabId, pendingLabId);
    await db.insert(organizations).values([
      { id: activeLabId, type: "lab", name: "Active Linked Lab" },
      { id: pendingLabId, type: "lab", name: "Pending Linked Lab" },
    ]);

    const activeMembershipId = rid("mem");
    const pendingMembershipId = rid("mem");
    createdMembershipIds.push(activeMembershipId, pendingMembershipId);
    await db.insert(organizationMemberships).values([
      {
        id: activeMembershipId,
        labId: activeLabId,
        userId: activeLinkedUserId,
        role: "user",
        status: "active",
      },
      {
        id: pendingMembershipId,
        labId: pendingLabId,
        userId: pendingLinkedUserId,
        role: "user",
        status: "active",
      },
    ]);

    const [userIdLow, userIdHigh] = [mainUserId, activeLinkedUserId].sort();
    const linkId = rid("link");
    createdLinkIds.push(linkId);
    await db.insert(doctorAccountLinks).values({
      id: linkId,
      userIdLow,
      userIdHigh,
      linkedVia: "manual",
    });

    const inviteId = rid("invite");
    createdInviteIds.push(inviteId);
    await db.insert(accountLinkInvites).values({
      id: inviteId,
      newUserId: mainUserId,
      existingUserId: pendingLinkedUserId,
      matchedOn: "email",
      status: "pending",
    });

    const res = await request(appMod.default)
      .get(`/api/admin/users/${mainUserId}/linked-labs`)
      .set("x-platform-admin-secret", PLATFORM_ADMIN_SECRET);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const linkedLabs = res.body.linkedLabs as Array<{
      labId: string;
      labName: string;
      status: string;
      linkedUserId: string;
    }>;
    expect(linkedLabs).toHaveLength(2);

    const active = linkedLabs.find((l) => l.labId === activeLabId);
    expect(active).toMatchObject({
      labName: "Active Linked Lab",
      status: "active",
      linkedUserId: activeLinkedUserId,
    });

    const pending = linkedLabs.find((l) => l.labId === pendingLabId);
    expect(pending).toMatchObject({
      labName: "Pending Linked Lab",
      status: "pending",
      linkedUserId: pendingLinkedUserId,
    });
  }, 15000);
});
