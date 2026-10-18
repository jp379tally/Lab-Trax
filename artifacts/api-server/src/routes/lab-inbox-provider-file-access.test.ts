/**
 * Integration tests: GET /api/lab-inbox/:fileId/file for provider callers.
 *
 * A provider can re-open a file they already sent to a lab, through the same
 * protected media path the lab itself uses. Access is deliberately tied to the
 * conditions that already govern GET /provider-sent, so the Sent list and the
 * file behind it can never disagree. Confirms:
 *
 *   1. The provider who uploaded the row → 200 with the file bytes and the
 *      same safe download headers the lab receives
 *   2. A different provider in the SAME lab → 403 (it is not their submission)
 *   3. A provider linked to a different lab → 403
 *   4. A lab member still gets 200 for the same row (no access removed)
 *   5. A note-only row (no file) → 404, not a partial/empty stream
 *
 * Skipped when DATABASE_URL is unset (same convention as sibling route tests).
 * All inserted rows and disk files are cleaned up in afterAll.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
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

// Object storage unavailable so the serving route takes the disk path and the
// test stays hermetic — no real bucket needed.
vi.mock("../lib/case-media-object-storage.js", () => ({
  caseMediaObjectStorageAvailable: () => false,
  caseMediaObjectStorageKeyExists: vi.fn().mockResolvedValue(false),
  writeCaseMediaToObjectStorage: vi.fn().mockResolvedValue(false),
  openCaseMediaObjectStream: vi.fn().mockResolvedValue(null),
  deleteCaseMediaFromObjectStorage: vi.fn().mockResolvedValue(false),
}));

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

maybe("GET /api/lab-inbox/:fileId/file — provider re-opens their own submission", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let authLib: typeof import("../lib/auth.js");

  const labId = rid("lab");
  const otherLabId = rid("otherlab");

  const senderProviderOrgId = rid("prov_sender");
  const peerProviderOrgId = rid("prov_peer");
  const unlinkedProviderOrgId = rid("prov_unlinked");

  const senderProviderId = rid("uprv_sender");
  const peerProviderId = rid("uprv_peer");
  const unlinkedProviderId = rid("uprv_unlinked");
  const labAdminId = rid("uadmin");

  const createdInboxFileIds: string[] = [];

  // Mirrors the route module constant.
  const caseMediaDir = path.resolve(process.cwd(), "uploads", "case-media");
  const storedFilename = `${Date.now()}-${randomBytes(4).toString("hex")}-provider-sent.pdf`;
  const fileBytes = Buffer.from("%PDF-1.4\nprovider-sent-file-for-test");

  let sentFileId = "";
  let noteOnlyId = "";

  let senderToken = "";
  let peerToken = "";
  let unlinkedToken = "";
  let labAdminToken = "";

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-provider-file-access";

    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    authLib = await import("../lib/auth.js");

    const { db, users, organizations, organizationMemberships, labInboxFiles } =
      dbMod as any;

    await db.insert(users).values([
      {
        id: senderProviderId,
        username: `sndprv_${senderProviderId}`.slice(0, 30),
        password: "x",
        userType: "provider",
      },
      {
        id: peerProviderId,
        username: `peerprv_${peerProviderId}`.slice(0, 30),
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
        id: senderProviderOrgId,
        type: "provider",
        name: rid("SenderPractice"),
        parentLabOrganizationId: labId,
      },
      {
        id: peerProviderOrgId,
        type: "provider",
        name: rid("PeerPractice"),
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
        userId: senderProviderId,
        labId: senderProviderOrgId,
        role: "member",
        status: "active",
        joinedAt: new Date(),
      },
      {
        id: rid("m"),
        userId: peerProviderId,
        labId: peerProviderOrgId,
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

    // The file the sender provider submitted — bytes on disk plus its row.
    fs.mkdirSync(caseMediaDir, { recursive: true });
    fs.writeFileSync(path.resolve(caseMediaDir, storedFilename), fileBytes);

    const [sentRow] = await db
      .insert(labInboxFiles)
      .values({
        labOrganizationId: labId,
        uploadedByUserId: senderProviderId,
        originalFilename: "rx-slip.pdf",
        mimeType: "application/pdf",
        sizeBytes: fileBytes.length,
        storagePath: storedFilename,
        note: "Rx attached",
      })
      .returning();
    sentFileId = sentRow.id;

    const [noteRow] = await db
      .insert(labInboxFiles)
      .values({
        labOrganizationId: labId,
        uploadedByUserId: senderProviderId,
        note: "Just a note, no file",
      })
      .returning();
    noteOnlyId = noteRow.id;

    createdInboxFileIds.push(sentFileId, noteOnlyId);
  });

  beforeEach(async () => {
    senderToken = await makeSession(dbMod, authLib, senderProviderId);
    peerToken = await makeSession(dbMod, authLib, peerProviderId);
    unlinkedToken = await makeSession(dbMod, authLib, unlinkedProviderId);
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

    fs.rmSync(path.resolve(caseMediaDir, storedFilename), { force: true });

    if (createdInboxFileIds.length) {
      await db
        .delete(labInboxFiles)
        .where(inArray(labInboxFiles.id, createdInboxFileIds))
        .catch(() => {});
    }

    const allUserIds = [
      senderProviderId,
      peerProviderId,
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
          senderProviderOrgId,
          peerProviderOrgId,
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

  it("serves the file to the provider who sent it, with the same safe headers", async () => {
    const res = await request(appMod.default)
      .get(`/api/lab-inbox/${sentFileId}/file`)
      .set("Authorization", `Bearer ${senderToken}`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/pdf/);
    expect(res.headers["content-disposition"]).toMatch(/^attachment;/);
    expect(res.headers["content-disposition"]).toContain("rx-slip.pdf");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(Buffer.from(res.body).equals(fileBytes)).toBe(true);
  });

  it("refuses a different provider in the same lab", async () => {
    const res = await request(appMod.default)
      .get(`/api/lab-inbox/${sentFileId}/file`)
      .set("Authorization", `Bearer ${peerToken}`);

    expect(res.status).toBe(403);
    expect(res.body.ok).toBe(false);
  });

  it("refuses a provider linked to a different lab", async () => {
    const res = await request(appMod.default)
      .get(`/api/lab-inbox/${sentFileId}/file`)
      .set("Authorization", `Bearer ${unlinkedToken}`);

    expect(res.status).toBe(403);
    expect(res.body.ok).toBe(false);
  });

  it("still serves the same file to a member of the receiving lab", async () => {
    const res = await request(appMod.default)
      .get(`/api/lab-inbox/${sentFileId}/file`)
      .set("Authorization", `Bearer ${labAdminToken}`);

    expect(res.status).toBe(200);
    expect(Buffer.from(res.body).equals(fileBytes)).toBe(true);
  });

  it("returns 404 for a note-only row the provider sent", async () => {
    const res = await request(appMod.default)
      .get(`/api/lab-inbox/${noteOnlyId}/file`)
      .set("Authorization", `Bearer ${senderToken}`);

    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
  });
});
