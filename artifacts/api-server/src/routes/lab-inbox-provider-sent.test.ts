/**
 * Integration tests: GET /api/lab-inbox/provider-sent
 *
 * Lets a provider see the history of notes/files they have personally
 * submitted to a lab via POST /provider-upload. Confirms:
 *
 *   1. Missing labOrganizationId query param → 400
 *   2. Non-provider user type (lab admin)     → 403
 *   3. Provider with no link to the target lab → 403
 *   4. Linked provider → 200, sees only their OWN rows for that lab
 *      (never another provider's submissions), newest first.
 *
 * Skipped when DATABASE_URL is unset (same convention as sibling route tests).
 * All inserted rows are cleaned up in afterAll.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { inArray } from "drizzle-orm";
import request from "supertest";

// ── Standard app-init side-effect mocks ──────────────────────────────────────
vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/case-media.js")>();
  return { ...actual, startDailyOrphanedMediaCleanup: vi.fn() };
});

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

async function makeSession(
  dbMod: any,
  authLib: any,
  userId: string,
): Promise<string> {
  const { db, userSessions } = dbMod;
  const sessionId = rid("sess");
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  const token = authLib.signAccessToken(userId, sessionId);
  const hash = createHash("sha256").update(token).digest("hex");
  await db
    .insert(userSessions)
    .values({ id: sessionId, userId, tokenHash: hash, expiresAt });
  return token;
}

maybe("GET /api/lab-inbox/provider-sent", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let authLib: typeof import("../lib/auth.js");

  const labId = rid("lab");
  const otherLabId = rid("otherlab");

  const linkedProviderOrgId = rid("prov_linked");
  const otherProviderOrgId = rid("prov_other");
  const unlinkedProviderOrgId = rid("prov_unlinked");

  const linkedProviderId = rid("uprv_linked");
  const otherProviderId = rid("uprv_other");
  const unlinkedProviderId = rid("uprv_unlinked");
  const labAdminId = rid("uadmin");

  const createdInboxFileIds: string[] = [];

  let linkedProviderToken = "";
  let otherProviderToken = "";
  let unlinkedProviderToken = "";
  let labAdminToken = "";

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-provider-sent";

    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    authLib = await import("../lib/auth.js");

    const { db, users, organizations, organizationMemberships } =
      dbMod as any;

    await db.insert(users).values([
      {
        id: linkedProviderId,
        username: `lnkprv_${linkedProviderId}`.slice(0, 30),
        password: "x",
        userType: "provider",
      },
      {
        id: otherProviderId,
        username: `othprv_${otherProviderId}`.slice(0, 30),
        password: "x",
        userType: "provider",
      },
      {
        id: unlinkedProviderId,
        username: `unlprv_${unlinkedProviderId}`.slice(0, 30),
        password: "x",
        userType: "provider",
      },
      {
        id: labAdminId,
        username: `labadm_${labAdminId}`.slice(0, 30),
        password: "x",
        userType: "lab",
      },
    ]);

    await db.insert(organizations).values([
      { id: labId, type: "lab", name: rid("TargetLab") },
      { id: otherLabId, type: "lab", name: rid("OtherLab") },
      {
        id: linkedProviderOrgId,
        type: "provider",
        name: rid("LinkedPractice"),
        parentLabOrganizationId: labId,
      },
      {
        id: otherProviderOrgId,
        type: "provider",
        name: rid("OtherPractice"),
        parentLabOrganizationId: labId,
      },
      {
        id: unlinkedProviderOrgId,
        type: "provider",
        name: rid("UnlinkedPractice"),
        parentLabOrganizationId: otherLabId,
      },
    ]);

    await db.insert(organizationMemberships).values([
      {
        id: rid("m"),
        userId: linkedProviderId,
        labId: linkedProviderOrgId,
        role: "member",
        status: "active",
        joinedAt: new Date(),
      },
      {
        id: rid("m"),
        userId: otherProviderId,
        labId: otherProviderOrgId,
        role: "member",
        status: "active",
        joinedAt: new Date(),
      },
      {
        id: rid("m"),
        userId: unlinkedProviderId,
        labId: unlinkedProviderOrgId,
        role: "member",
        status: "active",
        joinedAt: new Date(),
      },
      {
        id: rid("m"),
        userId: labAdminId,
        labId: labId,
        role: "admin",
        status: "active",
        joinedAt: new Date(),
      },
    ]);
  });

  beforeEach(async () => {
    linkedProviderToken = await makeSession(dbMod, authLib, linkedProviderId);
    otherProviderToken = await makeSession(dbMod, authLib, otherProviderId);
    unlinkedProviderToken = await makeSession(
      dbMod,
      authLib,
      unlinkedProviderId,
    );
    labAdminToken = await makeSession(dbMod, authLib, labAdminId);
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const {
      db,
      labInboxFiles,
      organizationMemberships,
      organizations,
      userSessions,
      users,
    } = dbMod as any;

    if (createdInboxFileIds.length) {
      await db
        .delete(labInboxFiles)
        .where(inArray(labInboxFiles.id, createdInboxFileIds))
        .catch(() => {});
    }

    const allUserIds = [
      linkedProviderId,
      otherProviderId,
      unlinkedProviderId,
      labAdminId,
    ];

    await db
      .delete(organizationMemberships)
      .where(inArray(organizationMemberships.userId, allUserIds))
      .catch(() => {});
    await db
      .delete(organizations)
      .where(
        inArray(organizations.id, [
          linkedProviderOrgId,
          otherProviderOrgId,
          unlinkedProviderOrgId,
          labId,
          otherLabId,
        ]),
      )
      .catch(() => {});
    await db
      .delete(userSessions)
      .where(inArray(userSessions.userId, allUserIds))
      .catch(() => {});
    await db.delete(users).where(inArray(users.id, allUserIds)).catch(() => {});
  });

  it("returns 400 when labOrganizationId query param is missing", async () => {
    const res = await request(appMod.default)
      .get("/api/lab-inbox/provider-sent")
      .set("Authorization", `Bearer ${linkedProviderToken}`);

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    // Thrown via HttpError → the global error handler serializes it as
    // `message` (not `error` — that key is only used by the pre-Multer
    // gate on the sibling POST /provider-upload route).
    expect(res.body.message).toMatch(/labOrganizationId/i);
  });

  it("returns 403 for a non-provider user (lab admin)", async () => {
    const res = await request(appMod.default)
      .get(`/api/lab-inbox/provider-sent?labOrganizationId=${labId}`)
      .set("Authorization", `Bearer ${labAdminToken}`);

    expect(res.status).toBe(403);
    expect(res.body.ok).toBe(false);
    expect(res.body.message).toMatch(/provider/i);
  });

  it("returns 403 for a provider with no link to the target lab", async () => {
    const res = await request(appMod.default)
      .get(`/api/lab-inbox/provider-sent?labOrganizationId=${labId}`)
      .set("Authorization", `Bearer ${unlinkedProviderToken}`);

    expect(res.status).toBe(403);
    expect(res.body.ok).toBe(false);
    expect(res.body.message).toMatch(/not linked|lab/i);
  });

  it("returns only the caller's own submissions for that lab, newest first", async () => {
    const { db, labInboxFiles } = dbMod as any;

    // Two rows from the linked provider (older + newer), one row from a
    // different provider in the SAME lab — must never leak into the result.
    const [olderMine] = await db
      .insert(labInboxFiles)
      .values({
        labOrganizationId: labId,
        uploadedByUserId: linkedProviderId,
        note: "First note",
        createdAt: new Date(Date.now() - 60_000),
      })
      .returning();
    const [newerMine] = await db
      .insert(labInboxFiles)
      .values({
        labOrganizationId: labId,
        uploadedByUserId: linkedProviderId,
        note: "Second note",
        originalFilename: "scan.pdf",
      })
      .returning();
    const [notMine] = await db
      .insert(labInboxFiles)
      .values({
        labOrganizationId: labId,
        uploadedByUserId: otherProviderId,
        note: "Someone else's note",
      })
      .returning();

    createdInboxFileIds.push(olderMine.id, newerMine.id, notMine.id);

    const res = await request(appMod.default)
      .get(`/api/lab-inbox/provider-sent?labOrganizationId=${labId}`)
      .set("Authorization", `Bearer ${linkedProviderToken}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const rows: Array<{ id: string; note: string | null }> = res.body.data;
    const ids = rows.map((r) => r.id);

    expect(ids).toContain(olderMine.id);
    expect(ids).toContain(newerMine.id);
    expect(ids).not.toContain(notMine.id);

    // Newest first
    expect(ids.indexOf(newerMine.id)).toBeLessThan(ids.indexOf(olderMine.id));
  });
});
