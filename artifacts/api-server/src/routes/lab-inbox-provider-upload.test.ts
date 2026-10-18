/**
 * Integration tests: POST /api/lab-inbox/provider-upload authorization gate.
 *
 * The pre-Multer gate rejects unauthorized requests BEFORE any bytes are
 * written to disk.  These tests confirm:
 *
 *   1. Missing labOrganizationId query param → 400
 *   2. Non-provider user type (lab admin)     → 403, no file on disk, no DB row
 *   3. Provider with no link to the target lab → 403, no file on disk, no DB row
 *   4. Active-content file types are rejected before storage
 *   5. Linked provider → 201, inbox row saved with correct uploadedByUserId
 *      and downloaded with safe response headers
 *
 * Skipped when DATABASE_URL is unset (same convention as sibling route tests).
 * All inserted rows are cleaned up in afterAll.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
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

// ── Object storage: unavailable so the handler takes the disk-only path ──────
// This keeps the success-case test hermetic — no real bucket needed.
vi.mock("../lib/case-media-object-storage.js", () => ({
  caseMediaObjectStorageAvailable: () => false,
  caseMediaObjectStorageKeyExists: vi.fn().mockResolvedValue(false),
  writeCaseMediaToObjectStorage: vi.fn().mockResolvedValue(false),
  openCaseMediaObjectStream: vi.fn().mockResolvedValue(null),
  deleteCaseMediaFromObjectStorage: vi.fn().mockResolvedValue(false),
}));

// ─────────────────────────────────────────────────────────────────────────────

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

/** Sign a fresh session token for the given user id and insert the session row. */
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

/** Return the set of filenames currently in the multer disk destination dir. */
function diskFileSet(dir: string): Set<string> {
  try {
    return new Set(fs.readdirSync(dir).filter((f) => !f.startsWith(".")));
  } catch {
    return new Set();
  }
}

maybe("POST /api/lab-inbox/provider-upload — authorization gate", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let authLib: typeof import("../lib/auth.js");

  // ── Test fixture ids ──────────────────────────────────────────────────────
  const labId = rid("lab");
  const otherLabId = rid("otherlab");

  // Provider org linked to labId
  const linkedProviderOrgId = rid("prov_linked");
  // Provider org linked to otherLabId — gives no access to labId
  const unlinkedProviderOrgId = rid("prov_unlinked");

  // A provider user whose provider-org is linked to labId
  const linkedProviderId = rid("uprv_linked");
  // A provider user whose provider-org points to otherLabId
  const unlinkedProviderId = rid("uprv_unlinked");
  // A lab-admin user (userType != "provider")
  const labAdminId = rid("uadmin");

  // Collect inbox file ids and disk paths for cleanup
  const createdInboxFileIds: string[] = [];

  // Path where multer writes files (mirrors the route module constant)
  const caseMediaDir = path.resolve(process.cwd(), "uploads", "case-media");

  // ── Session tokens (refreshed per test) ───────────────────────────────────
  let linkedProviderToken = "";
  let unlinkedProviderToken = "";
  let labAdminToken = "";

  // ── Fake file content for supertest attach() ──────────────────────────────
  const fakeFileContent = Buffer.from("%PDF-1.4\nfake-pdf-content-for-test");

  // ── Setup ─────────────────────────────────────────────────────────────────

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-provider-upload";

    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    authLib = await import("../lib/auth.js");

    const { db, users, organizations, organizationMemberships } =
      dbMod as any;

    // Insert users
    await db.insert(users).values([
      {
        id: linkedProviderId,
        username: `lnkprv_${linkedProviderId}`.slice(0, 30),
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

    // Insert orgs: the target lab, another lab, and two provider orgs
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
        id: unlinkedProviderOrgId,
        type: "provider",
        name: rid("UnlinkedPractice"),
        parentLabOrganizationId: otherLabId,
      },
    ]);

    // Memberships:
    //   linked provider → member of linkedProviderOrg (which belongs to labId)
    //   unlinked provider → member of unlinkedProviderOrg (belongs to otherLabId)
    //   lab admin → direct member of labId
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
      // Remove disk files created by the success-case test
      for (const id of createdInboxFileIds) {
        try {
          const rows = await db
            .select({ storagePath: labInboxFiles.storagePath })
            .from(labInboxFiles)
            .where(eq(labInboxFiles.id, id));
          if (rows[0]?.storagePath) {
            const diskPath = path.resolve(caseMediaDir, rows[0].storagePath);
            fs.unlink(diskPath, () => {});
          }
        } catch {
          // best-effort
        }
      }
      await db
        .delete(labInboxFiles)
        .where(inArray(labInboxFiles.id, createdInboxFileIds))
        .catch(() => {});
    }

    const allUserIds = [linkedProviderId, unlinkedProviderId, labAdminId];

    await db
      .delete(organizationMemberships)
      .where(inArray(organizationMemberships.userId, allUserIds))
      .catch(() => {});
    await db
      .delete(organizations)
      .where(
        inArray(organizations.id, [
          linkedProviderOrgId,
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
    await db
      .delete(users)
      .where(inArray(users.id, allUserIds))
      .catch(() => {});
  });

  // ── Test cases ─────────────────────────────────────────────────────────────

  it("returns 400 when labOrganizationId query param is missing", async () => {
    const before = diskFileSet(caseMediaDir);

    const res = await request(appMod.default)
      .post("/api/lab-inbox/provider-upload")
      // no ?labOrganizationId query param
      .set("Authorization", `Bearer ${linkedProviderToken}`)
      .attach("file", fakeFileContent, {
        filename: "test.pdf",
        contentType: "application/pdf",
      });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/labOrganizationId/i);

    // No file should have landed on disk
    const after = diskFileSet(caseMediaDir);
    const newFiles = [...after].filter((f) => !before.has(f));
    expect(newFiles).toHaveLength(0);

    // No inbox row should have been created
    const { db, labInboxFiles } = dbMod as any;
    const rows = await db
      .select()
      .from(labInboxFiles)
      .where(eq(labInboxFiles.labOrganizationId, labId));
    expect(rows.length).toBe(0);
  });

  it("returns 403 and writes no file for a non-provider user (lab admin)", async () => {
    const before = diskFileSet(caseMediaDir);

    const res = await request(appMod.default)
      .post(`/api/lab-inbox/provider-upload?labOrganizationId=${labId}`)
      .set("Authorization", `Bearer ${labAdminToken}`)
      .attach("file", fakeFileContent, {
        filename: "test.pdf",
        contentType: "application/pdf",
      });

    expect(res.status).toBe(403);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/provider/i);

    // No file should have landed on disk
    const after = diskFileSet(caseMediaDir);
    const newFiles = [...after].filter((f) => !before.has(f));
    expect(newFiles).toHaveLength(0);

    // No inbox row should have been created
    const { db, labInboxFiles } = dbMod as any;
    const rows = await db
      .select()
      .from(labInboxFiles)
      .where(eq(labInboxFiles.labOrganizationId, labId));
    expect(rows.length).toBe(0);
  });

  it("returns 403 and writes no file for a provider with no link to the target lab", async () => {
    const before = diskFileSet(caseMediaDir);

    const res = await request(appMod.default)
      .post(`/api/lab-inbox/provider-upload?labOrganizationId=${labId}`)
      .set("Authorization", `Bearer ${unlinkedProviderToken}`)
      .attach("file", fakeFileContent, {
        filename: "test.pdf",
        contentType: "application/pdf",
      });

    expect(res.status).toBe(403);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/not linked|lab/i);

    // No file should have landed on disk
    const after = diskFileSet(caseMediaDir);
    const newFiles = [...after].filter((f) => !before.has(f));
    expect(newFiles).toHaveLength(0);

    // No inbox row should have been created
    const { db, labInboxFiles } = dbMod as any;
    const rows = await db
      .select()
      .from(labInboxFiles)
      .where(eq(labInboxFiles.labOrganizationId, labId));
    expect(rows.length).toBe(0);
  });

  it.each([
    ["PDF", "payload.pdf", "application/pdf"],
    ["PNG image", "payload.png", "image/png"],
  ])(
    "returns 415 and writes no file when HTML bytes are disguised as a %s",
    async (_label, filename, contentType) => {
    const before = diskFileSet(caseMediaDir);

    const res = await request(appMod.default)
      .post(`/api/lab-inbox/provider-upload?labOrganizationId=${labId}`)
      .set("Authorization", `Bearer ${linkedProviderToken}`)
      .attach("file", Buffer.from("<script>alert('xss')</script>"), {
        filename,
        contentType,
      });

    expect(res.status).toBe(415);
    expect(res.body.ok).toBe(false);

    const after = diskFileSet(caseMediaDir);
    const newFiles = [...after].filter((f) => !before.has(f));
    expect(newFiles).toHaveLength(0);

    const { db, labInboxFiles } = dbMod as any;
    const rows = await db
      .select()
      .from(labInboxFiles)
      .where(eq(labInboxFiles.labOrganizationId, labId));
    expect(rows.length).toBe(0);
    },
  );

  it("returns 201 and saves an inbox row with the correct uploadedByUserId for a linked provider", async () => {
    const res = await request(appMod.default)
      .post(`/api/lab-inbox/provider-upload?labOrganizationId=${labId}`)
      .set("Authorization", `Bearer ${linkedProviderToken}`)
      .attach("file", fakeFileContent, {
        filename: "scan.pdf",
        contentType: "application/pdf",
      });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);

    const row = res.body.data;
    expect(row).toBeDefined();
    expect(row.labOrganizationId).toBe(labId);
    expect(row.uploadedByUserId).toBe(linkedProviderId);
    expect(row.originalFilename).toBe("scan.pdf");
    expect(row.id).toBeTruthy();

    createdInboxFileIds.push(row.id);

    // Verify the row is in the DB
    const { db, labInboxFiles } = dbMod as any;
    const [dbRow] = await db
      .select()
      .from(labInboxFiles)
      .where(eq(labInboxFiles.id, row.id));
    expect(dbRow).toBeDefined();
    expect(dbRow.uploadedByUserId).toBe(linkedProviderId);
    expect(dbRow.labOrganizationId).toBe(labId);

    const fileRes = await request(appMod.default)
      .get(`/api/lab-inbox/${row.id}/file`)
      .set("Authorization", `Bearer ${labAdminToken}`);

    expect(fileRes.status).toBe(200);
    expect(fileRes.headers["content-disposition"]).toMatch(/^attachment;/);
    expect(fileRes.headers["x-content-type-options"]).toBe("nosniff");
  });
});
