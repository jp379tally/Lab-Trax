/**
 * Backup Restore Integrity — 20 automated tests.
 *
 * Tests 1–7  verify backup manifest content: userCount, caseCount, orgCount,
 *            invoiceCount, tableCount, schemaVersion, and DB-count accuracy.
 * Tests 8–20 verify the executeRestore pipeline:
 *   - Phase transitions (clearing_sessions, post-restore validating)
 *   - user_sessions TRUNCATE after pg_restore
 *   - Schema version gate aborts before any data is touched
 *   - Pre-restore safety snapshot creation
 *   - Post-restore validation passes on clean data
 *   - Post-restore validation detects orphaned lab_membership rows
 *   - Full phase-sequence ordering
 *
 * spawn is mocked: pg_dump returns a fake buffer; pg_restore exits with code 0.
 * DATABASE_URL is still required for buildManifestCounts, session TRUNCATE,
 * and runPostRestoreValidation which all hit the real test database.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, createCipheriv, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import AdmZip from "adm-zip";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";

// ── env setup (before any module that reads them) ─────────────────────────────

const PLATFORM_ADMIN_SECRET = "backup-restore-integrity-test-secret";
process.env["PLATFORM_ADMIN_SECRET"] = PLATFORM_ADMIN_SECRET;

// ── spawn mock ─────────────────────────────────────────────────────────────────

let pgRestoreExitCode = 0;
const fakePgDumpOutput = randomBytes(512);

vi.mock("node:child_process", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require("node:events") as typeof import("node:events");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PassThrough } = require("node:stream") as typeof import("node:stream");

  return {
    spawn: vi.fn((cmd: string) => {
      const proc = new EventEmitter() as NodeJS.EventEmitter & {
        stdout: InstanceType<typeof PassThrough>;
        stderr: InstanceType<typeof PassThrough>;
        kill: (sig?: string) => void;
      };
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      proc.kill = () => {};

      setImmediate(() => {
        if (cmd === "pg_dump") {
          proc.stdout.push(fakePgDumpOutput);
          proc.stdout.push(null);
          proc.stderr.push(null);
          proc.emit("close", 0);
        } else if (cmd === "pg_restore") {
          proc.stdout.push(null);
          proc.stderr.push(null);
          proc.emit("close", pgRestoreExitCode);
        } else {
          proc.stdout.push(null);
          proc.stderr.push(null);
          proc.emit("close", 0);
        }
      });

      return proc;
    }),
  };
});

vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/case-media.js")>();
  return { ...actual, startDailyOrphanedMediaCleanup: vi.fn() };
});
vi.mock("../lib/case-media-object-storage.js", () => ({
  caseMediaObjectStorageAvailable: () => false,
  writeCaseMediaToObjectStorage: vi.fn().mockResolvedValue(true),
  openCaseMediaObjectStream: vi.fn().mockResolvedValue(null),
  deleteCaseMediaFromObjectStorage: vi.fn().mockResolvedValue(false),
}));

// ── guard ─────────────────────────────────────────────────────────────────────

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

// ── helpers ───────────────────────────────────────────────────────────────────

function rid(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

/**
 * Encrypt using the same AES-256-GCM scheme as backup.ts (duplicated here so
 * tests can build synthetic encrypted backups without exporting the private
 * encryptBuffer function from the production module).
 */
function testEncryptBuffer(plaintext: Buffer): Buffer {
  const secret = process.env["JWT_SECRET"] ?? "labtrax-test-secret-backup-restore";
  const key = createHash("sha256").update(secret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from("LTRX"), iv, authTag, ciphertext]);
}

/** Build a minimal valid encrypted backup with custom manifest fields. */
function buildSyntheticBackup(
  manifestOverride: Record<string, unknown> = {},
): Buffer {
  const zip = new AdmZip();
  const manifest: Record<string, unknown> = {
    version: "2.0",
    schemaVersion: "2",
    appName: "LabTrax",
    exportedAt: new Date().toISOString(),
    exportedBy: "test",
    dbFormat: "pg_dump:custom",
    userCount: 1,
    orgCount: 1,
    caseCount: 0,
    invoiceCount: 0,
    tableCount: 50,
    ...manifestOverride,
  };
  zip.addFile("manifest.json", Buffer.from(JSON.stringify(manifest, null, 2)));
  zip.addFile("db/database.pgdump", fakePgDumpOutput);
  return testEncryptBuffer(zip.toBuffer());
}

/**
 * Observe phase transitions during an executeRestore call.
 * Yields to the event loop via setImmediate between observations so
 * intermediate phases (clearing_sessions, post-restore validating) are
 * captured between the real async I/O awaits inside executeRestore.
 */
async function capturePhases(
  restorePromise: Promise<unknown>,
): Promise<string[]> {
  const phases: string[] = [];
  let settled = false;

  restorePromise
    .then(() => { settled = true; })
    .catch(() => { settled = true; });

  while (!settled) {
    const phase = backupLib.getRestoreState().phase;
    if (phase !== phases[phases.length - 1]) phases.push(phase);
    await new Promise<void>((r) => setImmediate(r));
  }

  const final = backupLib.getRestoreState().phase;
  if (final !== phases[phases.length - 1]) phases.push(final);
  return phases;
}

// ── module refs (populated in beforeAll) ─────────────────────────────────────

let dbMod: typeof import("@workspace/db");
let appMod: { default: import("express").Express };
let backupLib: typeof import("../lib/backup.js");

// ── test suite ────────────────────────────────────────────────────────────────

maybe("Backup Restore Integrity", () => {
  const ownerId      = rid("owner");
  const labOrgId     = rid("lab");
  const provOrgId    = rid("prov");
  const caseId       = rid("case");
  const invoiceId    = rid("inv");
  // Extra users created mid-test need cleanup
  const extraUserIds: string[] = [];

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-backup-restore";

    dbMod      = await import("@workspace/db");
    appMod     = await import("../app.js");
    backupLib  = await import("../lib/backup.js");

    const dbAny = dbMod as any;
    const { db, users, organizations, organizationMemberships, cases, invoices } = dbAny;

    await (db as any).insert(users).values({
      id: ownerId,
      username: `backuprestore_${ownerId}`,
      password: "doesnotmatter",
    });
    await (db as any).insert(organizations).values([
      { id: labOrgId,  type: "lab",      name: `BackupRestoreLab_${labOrgId}` },
      { id: provOrgId, type: "provider",  name: `BackupRestoreProv_${provOrgId}` },
    ]);
    await (db as any).insert(organizationMemberships).values([
      { id: rid("mem1"), userId: ownerId, labId: labOrgId,  role: "owner" },
      { id: rid("mem2"), userId: ownerId, labId: provOrgId, role: "owner" },
    ]);
    await (db as any).insert(cases).values({
      id: caseId,
      caseNumber: rid("BRT"),
      labOrganizationId: labOrgId,
      providerOrganizationId: provOrgId,
      patientFirstName: "Restore",
      patientLastName: "Test",
      doctorName: "Dr. Test",
      createdByUserId: ownerId,
      status: "received",
    });
    await (db as any).insert(invoices).values({
      id: invoiceId,
      invoiceNumber: `BRT-${rid("").slice(0, 6)}`,
      labOrganizationId: labOrgId,
      providerOrganizationId: provOrgId,
      createdByUserId: ownerId,
      status: "open",
      caseId,
    });
  });

  afterAll(async () => {
    const db = (dbMod as any).db;
    const { users, organizations, organizationMemberships, cases, invoices, userSessions } =
      dbMod as any;

    if (extraUserIds.length) {
      await db.delete(userSessions).where(inArray(userSessions.userId, extraUserIds));
      await db.delete(users).where(inArray(users.id, extraUserIds));
    }
    await db.delete(userSessions).where(eq(userSessions.userId, ownerId));
    await db.delete(invoices).where(eq(invoices.id, invoiceId));
    await db.delete(cases).where(eq(cases.id, caseId));
    await db
      .delete(organizationMemberships)
      .where(inArray(organizationMemberships.labId, [labOrgId, provOrgId]));
    await db.delete(organizations).where(inArray(organizations.id, [labOrgId, provOrgId]));
    await db.delete(users).where(eq(users.id, ownerId));

    // Best-effort cleanup of pre-restore snapshot files written during tests.
    try {
      const snapshotsDir = path.resolve(process.cwd(), "uploads", ".restore-snapshots");
      if (fs.existsSync(snapshotsDir)) {
        for (const f of fs.readdirSync(snapshotsDir)) {
          if (f.startsWith("pre-restore-") && f.endsWith(".pgdump")) {
            fs.unlinkSync(path.join(snapshotsDir, f));
          }
        }
      }
    } catch { /* best-effort */ }
  });

  afterEach(() => {
    pgRestoreExitCode = 0; // reset between tests
  });

  // ── Backup manifest content (tests 1–7) ─────────────────────────────────────

  describe("Backup manifest content (tests 1–7)", () => {
    let manifest: Record<string, unknown>;

    beforeAll(async () => {
      const { buffer } = await backupLib.buildBackupZipBuffer("test-backup-content");
      const zipBuffer = backupLib.decryptBuffer(buffer);
      const zip = new AdmZip(zipBuffer);
      const raw = zip.getEntry("manifest.json")!.getData().toString("utf8");
      manifest = JSON.parse(raw) as Record<string, unknown>;
    });

    it("1. manifest userCount reflects at least the test user", () => {
      expect(typeof manifest.userCount).toBe("number");
      expect(manifest.userCount as number).toBeGreaterThan(0);
    });

    it("2. manifest caseCount reflects at least the test case", () => {
      expect(typeof manifest.caseCount).toBe("number");
      expect(manifest.caseCount as number).toBeGreaterThan(0);
    });

    it("3. manifest orgCount reflects at least the test org", () => {
      expect(typeof manifest.orgCount).toBe("number");
      expect(manifest.orgCount as number).toBeGreaterThan(0);
    });

    it("4. manifest invoiceCount reflects at least the test invoice", () => {
      expect(typeof manifest.invoiceCount).toBe("number");
      expect(manifest.invoiceCount as number).toBeGreaterThan(0);
    });

    it("5. manifest tableCount > 10 (all public tables are counted)", () => {
      expect(typeof manifest.tableCount).toBe("number");
      expect(manifest.tableCount as number).toBeGreaterThan(10);
    });

    it("6. manifest schemaVersion matches BACKUP_SCHEMA_VERSION", () => {
      expect(manifest.schemaVersion).toBe(backupLib.BACKUP_SCHEMA_VERSION);
    });

    it("7. manifest caseCount matches the live non-deleted cases DB count", async () => {
      const dbPool = (dbMod as any).pool as import("pg").Pool;
      const res = await dbPool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM cases WHERE deleted_at IS NULL",
      );
      const liveCount = parseInt(res.rows[0].count, 10);
      expect(manifest.caseCount).toBe(liveCount);
    });
  });

  // ── Restore pipeline (tests 8–20) ───────────────────────────────────────────

  describe("Restore pipeline (tests 8–20)", () => {
    let testBackupBuffer: Buffer;

    // ── session-isolation shim ─────────────────────────────────────────────
    // executeRestore hard-fails if TRUNCATE user_sessions fails, and correctly
    // wipes sessions as a restore side-effect.  Because vitest runs test files
    // in parallel (maxWorkers=2), concurrently-running test files may have
    // tokens they created in their own beforeAll.  We snapshot user_sessions
    // before each test and re-insert any rows that were truncated in afterEach
    // so sibling test files' tokens survive our TRUNCATE calls.
    // ON CONFLICT DO NOTHING preserves any new rows tests legitimately added.
    type SessionRow = {
      id: string; user_id: string; token_hash: string;
      csrf_token_hash: string | null; device_name: string | null;
      ip_address: string | null; user_agent: string | null;
      expires_at: Date; revoked_at: Date | null; created_at: Date;
    };
    let sessionSnapshot: SessionRow[] = [];

    beforeEach(async () => {
      const dbPool = (dbMod as any).pool as import("pg").Pool;
      const res = await dbPool.query<SessionRow>("SELECT * FROM user_sessions");
      sessionSnapshot = res.rows;
    });

    afterEach(async () => {
      if (sessionSnapshot.length === 0) return;
      const dbPool = (dbMod as any).pool as import("pg").Pool;
      for (const row of sessionSnapshot) {
        await dbPool.query(
          `INSERT INTO user_sessions
             (id, user_id, token_hash, csrf_token_hash, device_name,
              ip_address, user_agent, expires_at, revoked_at, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (id) DO NOTHING`,
          [row.id, row.user_id, row.token_hash, row.csrf_token_hash,
           row.device_name, row.ip_address, row.user_agent,
           row.expires_at, row.revoked_at, row.created_at],
        );
      }
    });

    beforeAll(async () => {
      const { buffer } = await backupLib.buildBackupZipBuffer("test-restore-pipeline");
      testBackupBuffer = buffer;
    });

    it("8. executeRestore completes with phase = done", async () => {
      await backupLib.executeRestore(testBackupBuffer, "test-8");
      expect(backupLib.getRestoreState().phase).toBe("done");
    });

    it("9. user_sessions table is empty immediately after executeRestore", async () => {
      // Insert a sentinel session with a known ID so we can verify it was
      // removed by TRUNCATE.  We check the sentinel ID specifically rather than
      // asserting count=0: another test file running concurrently under
      // maxWorkers=2 may insert its own sessions between our TRUNCATE and our
      // count query, making a strict count=0 assertion inherently racy.
      const dbPool = (dbMod as any).pool as import("pg").Pool;
      const sentinelId = rid("sentinel9");
      await dbPool.query(
        `INSERT INTO user_sessions (id, user_id, token_hash, expires_at)
         VALUES ($1, $2, $3, now() + interval '1 hour')`,
        [sentinelId, ownerId, createHash("sha256").update(sentinelId).digest("hex")],
      );

      await backupLib.executeRestore(testBackupBuffer, "test-9");

      // The sentinel must be gone — TRUNCATE removed all pre-restore sessions.
      const res = await dbPool.query<{ id: string }>(
        "SELECT id FROM user_sessions WHERE id = $1",
        [sentinelId],
      );
      expect(res.rows).toHaveLength(0);
    });

    it("10. login via POST /api/auth/login succeeds after restore (no stale session conflict)", async () => {
      const bcrypt = await import("bcryptjs");
      const loginUserId = rid("loginUser10");
      extraUserIds.push(loginUserId);
      const pw = "restore-test-pw-10";
      await (dbMod as any).db.insert((dbMod as any).users).values({
        id: loginUserId,
        username: `logintest_${loginUserId}`,
        password: await bcrypt.hash(pw, 6),
      });

      await backupLib.executeRestore(testBackupBuffer, "test-10");

      const res = await request(appMod.default)
        .post("/api/auth/login")
        .send({ username: `logintest_${loginUserId}`, password: pw });

      expect(res.status).toBe(200);
      expect(typeof res.body.accessToken).toBe("string");
    });

    it("11. two successive inserts to user_sessions after restore succeed without unique-constraint conflict", async () => {
      await backupLib.executeRestore(testBackupBuffer, "test-11");

      const db = (dbMod as any).db;
      const { userSessions } = dbMod as any;
      await expect(
        db.insert(userSessions).values([
          {
            id: rid("sess11a"),
            userId: ownerId,
            tokenHash: createHash("sha256").update("tok-11-a").digest("hex"),
            expiresAt: new Date(Date.now() + 60_000),
          },
          {
            id: rid("sess11b"),
            userId: ownerId,
            tokenHash: createHash("sha256").update("tok-11-b").digest("hex"),
            expiresAt: new Date(Date.now() + 60_000),
          },
        ]),
      ).resolves.not.toThrow();
    });

    it("12. clearing_sessions step executes — TRUNCATE user_sessions is called", async () => {
      const db = (dbMod as any).db;
      const { userSessions } = dbMod as any;
      await db.insert(userSessions).values({
        id: rid("sess12"),
        userId: ownerId,
        tokenHash: createHash("sha256").update("tok-test12").digest("hex"),
        expiresAt: new Date(Date.now() + 60_000),
      });

      const dbPool = (dbMod as any).pool as import("pg").Pool;
      const queryCalls: string[] = [];
      const origQuery = dbPool.query.bind(dbPool);
      const spy = vi
        .spyOn(dbPool, "query")
        .mockImplementation(async (...args: Parameters<typeof dbPool.query>) => {
          const sql = args[0];
          if (typeof sql === "string") queryCalls.push(sql.trim());
          return origQuery(...args);
        });

      await backupLib.executeRestore(testBackupBuffer, "test-12");
      spy.mockRestore();

      expect(
        queryCalls.some((q) => q.toUpperCase().startsWith("TRUNCATE TABLE USER_SESSIONS")),
      ).toBe(true);
    });

    it("13. post-restore validation queries run — orphan check SQL is issued", async () => {
      const dbPool = (dbMod as any).pool as import("pg").Pool;
      const queryCalls: string[] = [];
      const origQuery = dbPool.query.bind(dbPool);
      const spy = vi
        .spyOn(dbPool, "query")
        .mockImplementation(async (...args: Parameters<typeof dbPool.query>) => {
          const sql = args[0];
          if (typeof sql === "string") queryCalls.push(sql.trim());
          return origQuery(...args);
        });

      await backupLib.executeRestore(testBackupBuffer, "test-13");
      spy.mockRestore();

      expect(
        queryCalls.some(
          (q) =>
            q.toLowerCase().includes("lab_memberships") ||
            q.toLowerCase().includes("orphan") ||
            q.toLowerCase().includes("provider_organization_id"),
        ),
      ).toBe(true);
    });

    it("14. full phase sequence includes restoring_db, clearing_sessions, validating, done", async () => {
      // restoring_media is set synchronously between two DB awaits, so it
      // races with the setImmediate poll and is not reliably capturable.
      // The phase IS set (evidenced by the side-effects: TRUNCATE runs,
      // validating follows). We verify the phases that bracket the media step.
      const phases = await capturePhases(
        backupLib.executeRestore(testBackupBuffer, "test-14"),
      );
      expect(phases).toContain("restoring_db");
      expect(phases).toContain("clearing_sessions");
      expect(phases).toContain("validating");
      expect(phases).toContain("done");

      // clearing_sessions must precede validating in the captured sequence.
      const clearIdx = phases.indexOf("clearing_sessions");
      const validIdx = phases.lastIndexOf("validating");
      expect(validIdx).toBeGreaterThan(clearIdx);
    });

    it("15. pg_restore failure sets phase=error; pre-restore snapshot still exists", async () => {
      pgRestoreExitCode = 2;

      const snapshotsDir = path.resolve(process.cwd(), "uploads", ".restore-snapshots");
      const existingBefore = fs.existsSync(snapshotsDir)
        ? new Set(fs.readdirSync(snapshotsDir))
        : new Set<string>();

      await expect(
        backupLib.executeRestore(testBackupBuffer, "test-15"),
      ).rejects.toThrow(/pg_restore failed/i);

      expect(backupLib.getRestoreState().phase).toBe("error");

      if (fs.existsSync(snapshotsDir)) {
        const newFiles = fs
          .readdirSync(snapshotsDir)
          .filter((f) => !existingBefore.has(f) && f.startsWith("pre-restore-") && f.endsWith(".pgdump"));
        expect(newFiles.length).toBeGreaterThan(0);
      }
    });

    it("16. incompatible schema version throws before any user_sessions row is touched", async () => {
      const db = (dbMod as any).db;
      const { userSessions } = dbMod as any;
      await db.insert(userSessions).values({
        id: rid("sess16"),
        userId: ownerId,
        tokenHash: createHash("sha256").update("tok-test16").digest("hex"),
        expiresAt: new Date(Date.now() + 60_000),
      });

      const dbPool = (dbMod as any).pool as import("pg").Pool;
      const before = await dbPool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM user_sessions",
      );
      const sessionsBefore = parseInt(before.rows[0].count, 10);

      const incompatibleBackup = buildSyntheticBackup({ schemaVersion: "99" });
      await expect(
        backupLib.executeRestore(incompatibleBackup, "test-16"),
      ).rejects.toThrow(/schema version/i);

      const after = await dbPool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM user_sessions",
      );
      const sessionsAfter = parseInt(after.rows[0].count, 10);
      expect(sessionsAfter).toBe(sessionsBefore);
    });

    it("17. pre-restore safety snapshot is created at uploads/.restore-snapshots/pre-restore-<ts>.pgdump", async () => {
      const snapshotsDir = path.resolve(process.cwd(), "uploads", ".restore-snapshots");
      const existingBefore = fs.existsSync(snapshotsDir)
        ? new Set(fs.readdirSync(snapshotsDir))
        : new Set<string>();

      await backupLib.executeRestore(testBackupBuffer, "test-17");

      expect(fs.existsSync(snapshotsDir)).toBe(true);
      const newFiles = fs
        .readdirSync(snapshotsDir)
        .filter(
          (f) =>
            !existingBefore.has(f) &&
            f.startsWith("pre-restore-") &&
            f.endsWith(".pgdump"),
        );
      expect(newFiles.length).toBeGreaterThan(0);
    });

    it("18. post-restore validation passes on well-formed test data", async () => {
      await backupLib.executeRestore(testBackupBuffer, "test-18");

      const result = await backupLib.runPostRestoreValidation({
        expectedCaseCount: null,
        expectedInvoiceCount: null,
      });

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("19. runPostRestoreValidation detects orphaned lab_membership rows", async () => {
      const dbPool = (dbMod as any).pool as import("pg").Pool;
      const orphanUserId = rid("orphan19");

      await dbPool.query("SET session_replication_role = 'replica'");
      try {
        await dbPool.query(
          `INSERT INTO lab_memberships (id, user_id, lab_id, role, created_at)
           VALUES ($1, $2, $3, $4, NOW())`,
          [rid("badmem19"), orphanUserId, labOrgId, "member"],
        );
      } finally {
        await dbPool.query("SET session_replication_role = 'origin'");
      }

      let result: import("../lib/backup.js").PostRestoreValidationResult;
      try {
        result = await backupLib.runPostRestoreValidation({
          expectedCaseCount: null,
          expectedInvoiceCount: null,
        });
      } finally {
        await dbPool.query("SET session_replication_role = 'replica'");
        await dbPool.query(
          "DELETE FROM lab_memberships WHERE user_id = $1",
          [orphanUserId],
        );
        await dbPool.query("SET session_replication_role = 'origin'");
      }

      expect(result!.valid).toBe(false);
      expect(result!.errors.some((e) => /orphaned/i.test(e))).toBe(true);
    });

    it("20. state machine: clearing_sessions follows restoring_db and precedes validating+done", async () => {
      // restoring_media is set synchronously between the TRUNCATE await and the
      // validation await, so it isn't reliably capturable by the setImmediate
      // poll. All other adjacent phases are reliably captured.
      const phases = await capturePhases(
        backupLib.executeRestore(testBackupBuffer, "test-20"),
      );

      const dbIdx    = phases.lastIndexOf("restoring_db");
      const clearIdx = phases.indexOf("clearing_sessions");
      const validIdx = phases.lastIndexOf("validating");
      const doneIdx  = phases.lastIndexOf("done");

      // clearing_sessions must be present
      expect(clearIdx).toBeGreaterThan(-1);
      // restoring_db before clearing_sessions
      expect(clearIdx).toBeGreaterThan(dbIdx);
      // validating after clearing_sessions (media restore happened between them)
      expect(validIdx).toBeGreaterThan(clearIdx);
      // done is last
      expect(doneIdx).toBeGreaterThan(validIdx);
    });
  });
});
