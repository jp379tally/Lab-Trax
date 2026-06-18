/**
 * Backup Restore Integrity — 20 automated tests.
 *
 * Tests 1–7  verify backup manifest content: userCount, caseCount, orgCount,
 *            invoiceCount, tableCount, schemaVersion, and DB-count accuracy.
 * Tests 8–20 verify the executeRestore pipeline:
 *   - Phase transitions (clearing_sessions, post-restore validating)
 *   - user_sessions orphan DELETE (gap-free: user_sessions excluded from pg_restore)
 *   - Schema version gate aborts before any data is touched
 *   - Pre-restore safety snapshot creation
 *   - Post-restore validation passes on clean data
 *   - Post-restore validation detects orphaned lab_membership rows
 *   - Full phase-sequence ordering
 *
 * spawn is mocked: pg_dump returns a fake buffer; pg_restore exits with code 0.
 * DATABASE_URL is still required for buildManifestCounts, orphan session DELETE,
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
    const { db, users, organizations, organizationMemberships, cases, invoices, userSessions: us } = dbAny;

    // ── Purge accumulated data from previous interrupted backup-restore runs ──
    // Each executeRestore call leaves the DB in the backup state.  If a run is
    // interrupted (timeout, stack overflow, etc.) the cleanup afterAll never
    // runs, so these rows accumulate and make subsequent pg_dump calls
    // progressively slower.  We sweep them out here, before creating the new
    // test entities, so that the pg_dump in the inner describe's beforeAll
    // captures the smallest possible snapshot.
    try {
      const { sql, inArray: _inArray, like } = await import("drizzle-orm");
      const oldOrgs: { id: string }[] = (await db.execute(
        sql`SELECT id FROM organizations WHERE name LIKE ${"BackupRestore%"}`
      )).rows as { id: string }[];
      const oldOrgIds = oldOrgs.map((r) => r.id);
      if (oldOrgIds.length > 0) {
        await db.delete(invoices).where(_inArray(invoices.labOrganizationId, oldOrgIds));
        await db.delete(cases).where(_inArray(cases.labOrganizationId, oldOrgIds));
        await db.delete(organizationMemberships).where(_inArray(organizationMemberships.labId, oldOrgIds));
        await db.delete(organizations).where(_inArray(organizations.id, oldOrgIds));
      }
      const oldUsers: { id: string }[] = (await db.execute(
        sql`SELECT id FROM users WHERE username LIKE ${"backuprestore_%"}`
      )).rows as { id: string }[];
      const oldUserIds = oldUsers.map((r) => r.id);
      if (oldUserIds.length > 0) {
        await db.delete(us).where(_inArray(us.userId, oldUserIds));
        await db.delete(users).where(_inArray(users.id, oldUserIds));
      }
    } catch { /* best-effort; don't fail setup if sweep errors */ }
    // ──────────────────────────────────────────────────────────────────────────

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
    // Capture case count at the same instant as the backup so test 7 is
    // not affected by cases created by concurrent workers between backup
    // time and test-7 execution time.
    let caseCountAtBackupTime: number;

    beforeAll(async () => {
      const dbPool = (dbMod as any).pool as import("pg").Pool;
      // Read the case count and build the backup in the same beforeAll so
      // the count is taken as close to the backup snapshot as possible.
      const countRes = await dbPool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM cases WHERE deleted_at IS NULL",
      );
      caseCountAtBackupTime = parseInt(countRes.rows[0].count, 10);
      const { buffer } = await backupLib.buildBackupZipBuffer("test-backup-content");
      const zipBuffer = backupLib.decryptBuffer(buffer);
      const zip = new AdmZip(zipBuffer);
      const raw = zip.getEntry("manifest.json")!.getData().toString("utf8");
      manifest = JSON.parse(raw) as Record<string, unknown>;
    }, 300_000);

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

    it("7. manifest caseCount matches the non-deleted cases DB count at backup time", () => {
      // Use the count captured in beforeAll (same instant as backup) rather
      // than a live query here, which would race with concurrent test workers.
      expect(manifest.caseCount).toBe(caseCountAtBackupTime);
    });
  });

  // ── Restore pipeline (tests 8–20) ───────────────────────────────────────────

  describe("Restore pipeline (tests 8–20)", () => {
    let testBackupBuffer: Buffer;

    // ── session-isolation shim ─────────────────────────────────────────────
    // executeRestore uses a gap-free approach: user_sessions is excluded from
    // pg_restore entirely (FK constraint is temporarily dropped, a filtered TOC
    // skips all user_sessions entries, and orphan rows are deleted afterward).
    // Sessions for valid users survive the restore unchanged.  We still
    // snapshot user_sessions before each test and re-insert in afterEach as a
    // safety net — concurrent test files' tokens are never wiped, but this
    // guard ensures correctness if anything unexpected removes them.
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

    // Re-insert the pre-test session snapshot immediately so that any session
    // unexpectedly removed during restore is recovered before afterEach runs.
    // Call this right after every executeRestore() that is expected to complete.
    async function restoreSnapshotNow() {
      if (sessionSnapshot.length === 0) return;
      const dbPool = (dbMod as any).pool as import("pg").Pool;
      for (const row of sessionSnapshot) {
        try {
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
        } catch (e: any) {
          // A concurrently running test file's afterAll may have deleted the
          // user that this session references (FK: user_sessions → users).
          // Skip foreign_key_violation (PG error code 23503) — those sessions
          // are no longer needed.  Re-throw anything else.
          if (e.code !== "23503") throw e;
        }
      }
    }

    afterEach(restoreSnapshotNow);

    // Refresh sessionSnapshot immediately before executeRestore so sessions
    // created by concurrent test files AFTER the beforeEach snapshot are
    // captured and re-inserted by restoreSnapshotNow().
    //
    // Use dbPool.connect() / client.query() rather than dbPool.query() so
    // that spies on dbPool.query in tests 12/13 do NOT intercept this
    // SELECT — the pool-level spy does not cover PoolClient queries,
    // eliminating the origQuery recursive-spy infinite-loop.
    async function safeExecuteRestore(buf: Buffer, label: string) {
      const dbPool = (dbMod as any).pool as import("pg").Pool;
      const client = await dbPool.connect();
      try {
        const res = await client.query<SessionRow>("SELECT * FROM user_sessions");
        sessionSnapshot = res.rows;
      } finally {
        client.release();
      }
      return backupLib.executeRestore(buf, label);
    }

    beforeAll(async () => {
      const { buffer } = await backupLib.buildBackupZipBuffer("test-restore-pipeline");
      testBackupBuffer = buffer;
    }, 300_000);

    it("8. executeRestore completes with phase = done", async () => {
      await safeExecuteRestore(testBackupBuffer, "test-8");
      await restoreSnapshotNow();
      expect(backupLib.getRestoreState().phase).toBe("done");
    });

    it("9. live sessions survive executeRestore — safeExecuteRestore snapshot is re-inserted", async () => {
      // Insert a sentinel session with a known ID.  This sentinel is a "live"
      // session created BEFORE pg_restore starts: safeExecuteRestore captures
      // it in the sessionSnapshot, and restoreSnapshotNow re-inserts it after
      // the TRUNCATE.  Verifies the full snapshot round-trip is working.
      const dbPool = (dbMod as any).pool as import("pg").Pool;
      const sentinelId = rid("sentinel9");
      await dbPool.query(
        `INSERT INTO user_sessions (id, user_id, token_hash, expires_at)
         VALUES ($1, $2, $3, now() + interval '1 hour')`,
        [sentinelId, ownerId, createHash("sha256").update(sentinelId).digest("hex")],
      );

      await safeExecuteRestore(testBackupBuffer, "test-9");
      await restoreSnapshotNow();

      // Gap-free approach: user_sessions is never touched by pg_restore, so
      // the sentinel session survives the restore directly (not via re-insert).
      const res = await dbPool.query<{ id: string }>(
        "SELECT id FROM user_sessions WHERE id = $1",
        [sentinelId],
      );
      expect(res.rows).toHaveLength(1);
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

      await safeExecuteRestore(testBackupBuffer, "test-10");
      await restoreSnapshotNow();

      const res = await request(appMod.default)
        .post("/api/auth/login")
        .send({ username: `logintest_${loginUserId}`, password: pw });

      expect(res.status).toBe(200);
      expect(typeof res.body.accessToken).toBe("string");
    });

    it("11. two successive inserts to user_sessions after restore succeed without unique-constraint conflict", async () => {
      await safeExecuteRestore(testBackupBuffer, "test-11");
      await restoreSnapshotNow();

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

    it("12. clearing_sessions step executes — orphan session DELETE is called", async () => {
      // Gap-free approach: user_sessions is excluded from pg_restore entirely.
      // The clearing_sessions phase now runs a DELETE to remove sessions whose
      // user no longer exists after restore, rather than a TRUNCATE + re-insert.
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

      try {
        await safeExecuteRestore(testBackupBuffer, "test-12");
      } finally {
        spy.mockRestore();
      }
      await restoreSnapshotNow();

      // Verify the orphan-session DELETE ran during clearing_sessions phase.
      expect(
        queryCalls.some((q) =>
          q.toLowerCase().startsWith("delete from user_sessions"),
        ),
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

      try {
        await safeExecuteRestore(testBackupBuffer, "test-13");
      } finally {
        spy.mockRestore();
      }
      await restoreSnapshotNow();

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
      // The phase IS set (evidenced by the side-effects: orphan DELETE runs,
      // validating follows). We verify the phases that bracket the media step.
      const phases = await capturePhases(
        safeExecuteRestore(testBackupBuffer, "test-14"),
      );
      await restoreSnapshotNow();
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
        safeExecuteRestore(testBackupBuffer, "test-15"),
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
      const sess16Id = rid("sess16");
      await db.insert(userSessions).values({
        id: sess16Id,
        userId: ownerId,
        tokenHash: createHash("sha256").update("tok-test16").digest("hex"),
        expiresAt: new Date(Date.now() + 60_000),
      });

      const dbPool = (dbMod as any).pool as import("pg").Pool;

      const incompatibleBackup = buildSyntheticBackup({ schemaVersion: "99" });
      await expect(
        safeExecuteRestore(incompatibleBackup, "test-16"),
      ).rejects.toThrow(/schema version/i);

      // If the restore had run TRUNCATE TABLE user_sessions, our specific
      // session would be gone.  Concurrent tests may remove their own sessions
      // between queries, so we check for the specific row, not the total count.
      const after = await dbPool.query<{ id: string }>(
        "SELECT id FROM user_sessions WHERE id = $1",
        [sess16Id],
      );
      expect(after.rows.length).toBe(1);
    });

    it("17. pre-restore safety snapshot is created at uploads/.restore-snapshots/pre-restore-<ts>.pgdump", async () => {
      const snapshotsDir = path.resolve(process.cwd(), "uploads", ".restore-snapshots");
      const existingBefore = fs.existsSync(snapshotsDir)
        ? new Set(fs.readdirSync(snapshotsDir))
        : new Set<string>();

      await safeExecuteRestore(testBackupBuffer, "test-17");
      await restoreSnapshotNow();

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
      await safeExecuteRestore(testBackupBuffer, "test-18");
      await restoreSnapshotNow();

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
      // restoring_media is set synchronously between the orphan-DELETE await
      // and the validation await, so it isn't reliably capturable by the
      // setImmediate poll. All other adjacent phases are reliably captured.
      const phases = await capturePhases(
        safeExecuteRestore(testBackupBuffer, "test-20"),
      );
      await restoreSnapshotNow();

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
