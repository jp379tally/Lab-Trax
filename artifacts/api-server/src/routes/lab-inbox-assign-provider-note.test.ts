/**
 * Regression tests: POST /api/lab-inbox/:fileId/assign — providerNote in caseEvents.
 *
 * The assign handler copies `inboxFile.note` into the timeline event's
 * `metadataJson.providerNote`.  These tests pin that behaviour so a future
 * refactor cannot silently drop the field.
 *
 *   1. When the inbox file has a non-empty note → metadataJson.providerNote
 *      matches the note exactly.
 *   2. When the inbox file has a null note → metadataJson has no providerNote
 *      key at all.
 *
 * Skipped when DATABASE_URL is unset (same convention as sibling route tests).
 * All inserted rows are cleaned up in afterAll.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
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
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

const caseMediaDir = path.resolve(process.cwd(), "uploads", "case-media");

/** Write a tiny placeholder file to the case-media dir and return its filename. */
function createTempInboxFile(): string {
  fs.mkdirSync(caseMediaDir, { recursive: true });
  const filename = `${Date.now()}-${randomBytes(4).toString("hex")}-test.pdf`;
  fs.writeFileSync(
    path.resolve(caseMediaDir, filename),
    Buffer.from("fake-inbox-file-content"),
  );
  return filename;
}

/** Sign a session token and insert the session row. */
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

maybe(
  "POST /api/lab-inbox/:fileId/assign — providerNote in caseEvents metadataJson",
  () => {
    let dbMod: typeof import("@workspace/db");
    let appMod: { default: import("express").Express };
    let authLib: typeof import("../lib/auth.js");

    // ── Fixture ids ───────────────────────────────────────────────────────────
    const labId = rid("lab");
    const providerOrgId = rid("prov");
    const adminUserId = rid("uadmin");

    // Tracks ids/filenames created during each test for cleanup
    const createdCaseIds: string[] = [];
    const createdInboxFileIds: string[] = [];
    const createdTempFiles: string[] = [];

    let adminToken = "";

    // ── Setup ─────────────────────────────────────────────────────────────────

    beforeAll(async () => {
      process.env["JWT_SECRET"] =
        process.env["JWT_SECRET"] ?? "labtrax-test-secret-assign-provider-note";

      dbMod = await import("@workspace/db");
      appMod = await import("../app.js");
      authLib = await import("../lib/auth.js");

      const { db, users, organizations, organizationMemberships } =
        dbMod as any;

      await db.insert(users).values([
        {
          id: adminUserId,
          username: `adm_${adminUserId}`.slice(0, 30),
          password: "x",
          userType: "lab",
        },
      ]);

      await db.insert(organizations).values([
        { id: labId, type: "lab", name: rid("AssignTestLab") },
        {
          id: providerOrgId,
          type: "provider",
          name: rid("AssignTestProvider"),
          parentLabOrganizationId: labId,
        },
      ]);

      await db.insert(organizationMemberships).values([
        {
          id: rid("m"),
          userId: adminUserId,
          labId: labId,
          role: "admin",
          status: "active",
          joinedAt: new Date(),
        },
      ]);
    });

    beforeEach(async () => {
      adminToken = await makeSession(dbMod, authLib, adminUserId);
    });

    afterAll(async () => {
      if (!SHOULD_RUN) return;
      const {
        db,
        cases,
        caseEvents,
        caseAttachments,
        labInboxFiles,
        organizationMemberships,
        organizations,
        userSessions,
        users,
      } = dbMod as any;

      // Delete cases first (caseEvents + caseAttachments cascade from cases)
      if (createdCaseIds.length) {
        await db
          .delete(cases)
          .where(inArray(cases.id, createdCaseIds))
          .catch(() => {});
      }

      // Delete any lingering inbox file rows
      if (createdInboxFileIds.length) {
        await db
          .delete(labInboxFiles)
          .where(inArray(labInboxFiles.id, createdInboxFileIds))
          .catch(() => {});
      }

      // Remove temp disk files
      for (const filename of createdTempFiles) {
        try {
          fs.unlinkSync(path.resolve(caseMediaDir, filename));
        } catch {
          // best-effort
        }
      }
      // Also clean up any attachment files written by the handler
      try {
        const files = fs.readdirSync(caseMediaDir);
        for (const f of files) {
          if (f.startsWith(".")) continue;
          // Handler-written attachment filenames include a UUID; remove only
          // those whose corresponding DB row is gone (best-effort sweep).
        }
      } catch {
        // ignore
      }

      await db
        .delete(organizationMemberships)
        .where(eq(organizationMemberships.userId, adminUserId))
        .catch(() => {});
      await db
        .delete(organizations)
        .where(inArray(organizations.id, [labId, providerOrgId]))
        .catch(() => {});
      await db
        .delete(userSessions)
        .where(eq(userSessions.userId, adminUserId))
        .catch(() => {});
      await db
        .delete(users)
        .where(eq(users.id, adminUserId))
        .catch(() => {});
    });

    // ── Helpers ───────────────────────────────────────────────────────────────

    /** Insert a minimal case and return its id. */
    async function createCase(): Promise<string> {
      const { db, cases } = dbMod as any;
      const caseId = randomUUID();
      const caseNumber = `TST-${randomBytes(4).toString("hex").toUpperCase()}`;
      await db.insert(cases).values({
        id: caseId,
        caseNumber,
        labOrganizationId: labId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Test",
        patientLastName: "Patient",
        doctorName: "Dr. Test",
        createdByUserId: adminUserId,
      });
      createdCaseIds.push(caseId);
      return caseId;
    }

    /** Insert a labInboxFiles row backed by a real temp file on disk. */
    async function createInboxFile(
      note: string | null,
    ): Promise<{ id: string; filename: string }> {
      const { db, labInboxFiles } = dbMod as any;
      const filename = createTempInboxFile();
      createdTempFiles.push(filename);

      const [row] = await db
        .insert(labInboxFiles)
        .values({
          labOrganizationId: labId,
          uploadedByUserId: adminUserId,
          originalFilename: "provider-scan.pdf",
          mimeType: "application/pdf",
          sizeBytes: 23,
          storagePath: filename,
          objectStorageKey: null,
          note,
        })
        .returning();

      createdInboxFileIds.push(row.id);
      return { id: row.id, filename };
    }

    /** Read the caseEvents rows for a case, filtered to file_assigned_from_inbox. */
    async function getAssignEvents(caseId: string): Promise<any[]> {
      const { db, caseEvents } = dbMod as any;
      const rows = await db
        .select()
        .from(caseEvents)
        .where(eq(caseEvents.caseId, caseId));
      return rows.filter(
        (r: any) => r.eventType === "file_assigned_from_inbox",
      );
    }

    // ── Tests ─────────────────────────────────────────────────────────────────

    it(
      "sets metadataJson.providerNote when the inbox file has a non-empty note",
      async () => {
        const caseId = await createCase();
        const { id: fileId, filename: inboxFilename } =
          await createInboxFile("Please check the margin on tooth 14.");

        const res = await request(appMod.default)
          .post(`/api/lab-inbox/${fileId}/assign`)
          .set("Authorization", `Bearer ${adminToken}`)
          .send({ caseId });

        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);

        // Verify the caseEvents row carries the note
        const events = await getAssignEvents(caseId);
        expect(events).toHaveLength(1);
        const metadata = events[0].metadataJson as Record<string, unknown>;
        expect(metadata["providerNote"]).toBe(
          "Please check the margin on tooth 14.",
        );

        // Record the attachment file for cleanup (handler writes a copy)
        const { db, caseAttachments } = dbMod as any;
        const attRows = await db
          .select({
            storageKey: caseAttachments.storageKey,
            note: caseAttachments.note,
          })
          .from(caseAttachments)
          .where(eq(caseAttachments.caseId, caseId));
        expect(attRows[0]?.note).toBe("Please check the margin on tooth 14.");
        for (const att of attRows) {
          createdTempFiles.push(att.storageKey);
        }
      },
      30_000,
    );

    it(
      "omits providerNote from metadataJson when the inbox file note is null",
      async () => {
        const caseId = await createCase();
        const { id: fileId } = await createInboxFile(null);

        const res = await request(appMod.default)
          .post(`/api/lab-inbox/${fileId}/assign`)
          .set("Authorization", `Bearer ${adminToken}`)
          .send({ caseId });

        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);

        // Verify the caseEvents row does NOT carry the key
        const events = await getAssignEvents(caseId);
        expect(events).toHaveLength(1);
        const metadata = events[0].metadataJson as Record<string, unknown>;
        expect(Object.prototype.hasOwnProperty.call(metadata, "providerNote")).toBe(false);

        // Record the attachment file for cleanup
        const { db, caseAttachments } = dbMod as any;
        const attRows = await db
          .select({
            storageKey: caseAttachments.storageKey,
            note: caseAttachments.note,
          })
          .from(caseAttachments)
          .where(eq(caseAttachments.caseId, caseId));
        expect(attRows[0]?.note).toBeNull();
        for (const att of attRows) {
          createdTempFiles.push(att.storageKey);
        }
      },
      30_000,
    );
  },
);
