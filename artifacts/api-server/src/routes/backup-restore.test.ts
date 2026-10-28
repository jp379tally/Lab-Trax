/**
 * Backup Restore Integrity — automated tests.
 *
 * Tests 1–7  verify backup manifest content: userCount, caseCount, orgCount,
 *            invoiceCount, tableCount, schemaVersion, and DB-count accuracy.
 * Tests 8–21 verify the executeRestore pipeline:
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
import { requireIsolatedRestoreTest } from "../lib/restore-test-isolation";

// This suite uses a disposable DB and synthetic Graph transport. Never write
// an encrypted fixture to the workspace's real App Storage during the gate.
vi.mock("../lib/backup-cloud-staging", () => ({
  createBackupCloudStage: async () => {
    const { Writable } = await import("node:stream");
    const chunks: Buffer[] = [];
    let bytes = Buffer.alloc(0);
    return {
      open: () => new Writable({
        write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); },
      }),
      seal: async (size: number) => {
        bytes = Buffer.concat(chunks);
        if (bytes.length !== size) throw new Error("Synthetic cloud stage size mismatch");
      },
      readChunk: async (offset: number, length: number) => bytes.subarray(offset, offset + length),
      cleanup: async () => { chunks.length = 0; bytes = Buffer.alloc(0); },
    };
  },
}));

// ── env setup (before any module that reads them) ─────────────────────────────

const PLATFORM_ADMIN_SECRET = "backup-restore-integrity-test-secret";
process.env["PLATFORM_ADMIN_SECRET"] = PLATFORM_ADMIN_SECRET;

// ── spawn mock ─────────────────────────────────────────────────────────────────

let pgRestoreExitCode = 0;
const fakePgDumpOutput = randomBytes(512);
const childProcessMockState = vi.hoisted(() => ({
  useRealCommands: false,
  realPgRestoreResults: [] as Array<{
    args: readonly string[];
    code: number | null;
    stderr: string;
  }>,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require("node:events") as typeof import("node:events");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PassThrough } = require("node:stream") as typeof import("node:stream");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePath = require("node:path") as typeof import("node:path");

  // The backup pipeline spawns the packaged launcher by absolute path when one
  // is present (the production image, and the isolated gate that stages the
  // same layout), and the bare program name only in the dev workspace. Match on
  // the program name so this mock keeps describing the same two tools either
  // way — comparing the whole command silently fell through to the "unknown
  // program" branch under the gate and produced an empty dump.
  const programName = (cmd: string): string => nodePath.basename(cmd);

  return {
    ...actual,
    spawn: vi.fn((cmd: string, args?: readonly string[], options?: import("node:child_process").SpawnOptions) => {
      if (childProcessMockState.useRealCommands) {
        const proc = actual.spawn(cmd, args ?? [], options ?? {});
        if (programName(cmd) === "pg_restore" && !(args ?? []).includes("--list")) {
          const stderrChunks: Buffer[] = [];
          proc.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
          proc.on("close", (code) => {
            childProcessMockState.realPgRestoreResults.push({
              args: args ?? [],
              code,
              stderr: Buffer.concat(stderrChunks).toString("utf8"),
            });
          });
        }
        return proc;
      }
      const proc = new EventEmitter() as NodeJS.EventEmitter & {
        stdout: InstanceType<typeof PassThrough>;
        stderr: InstanceType<typeof PassThrough>;
        kill: (sig?: string) => void;
      };
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      proc.kill = () => {};

      setImmediate(() => {
        if (programName(cmd) === "pg_dump") {
          proc.stdout.push(fakePgDumpOutput);
          proc.stdout.push(null);
          proc.stderr.push(null);
          proc.emit("close", 0);
        } else if (programName(cmd) === "pg_restore") {
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
  const secret = process.env["BACKUP_ENCRYPTION_KEY"] || process.env["JWT_SECRET"] || "labtrax-test-secret-backup-restore";
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

async function buildLegacyReceivedDateBackup(): Promise<Buffer> {
  // Keep this date-conversion fixture dependency-complete. The historical
  // dump predates newer evidence tables whose FKs otherwise prevent --clean
  // from replacing cases. Never strip those FKs from the database under test.
  requireIsolatedRestoreTest();
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const { resolvePostgresTool } = await import("../lib/pg-tools");
  const { Pool } = (await import("pg")).default;
  const fixtureName = `legacy_received_fixture_${randomBytes(6).toString("hex")}`;
  const root = fs.mkdtempSync(path.join(process.env.LABTRAX_ISOLATED_RESTORE_ROOT!, "received-fixture-"));
  const schemaFile = path.join(root, "schema.pgdump");
  const fixtureFile = path.join(root, "fixture.pgdump");
  const sourceUrl = process.env.DATABASE_URL!;
  const fixtureUrl = new URL(sourceUrl);
  fixtureUrl.pathname = `/${fixtureName}`;
  const admin = (dbMod as any).pool as import("pg").Pool;
  let created = false;
  let fixturePool: import("pg").Pool | null = null;
  let dump: Buffer;
  let tableCount: number;
  try {
    await admin.query(`CREATE DATABASE "${fixtureName}"`);
    created = true;
    // The current schema-only import takes longer than 30 seconds in this
    // workspace. execFile kills pg_restore at its timeout, which can surface as
    // SIGPIPE rather than a useful restore error. Keep a bounded but generous
    // budget for these fixture-only PostgreSQL commands.
    const options = { timeout: 120_000, maxBuffer: 1024 * 1024 };
    await run(resolvePostgresTool("pg_dump"), ["--schema-only", "--format=custom", `--file=${schemaFile}`, sourceUrl], options);
    await run(resolvePostgresTool("pg_restore"), ["--exit-on-error", `--dbname=${fixtureUrl}`, schemaFile], options);
    fixturePool = new Pool({ connectionString: fixtureUrl.toString() });
    await fixturePool.query(`
      ALTER TABLE cases ALTER COLUMN received_at TYPE timestamptz USING received_at::timestamptz;
      ALTER TABLE case_restorations DROP COLUMN IF EXISTS implant_retention,
        DROP COLUMN IF EXISTS implant_manufacturer, DROP COLUMN IF EXISTS implant_platform_notes;
    `);
    // Keep the legacy input source-only and synthetic so a clean checkout
    // can build the archive without an ignored binary database fixture.
    // The fixture database keeps its current foreign-key and ownership guards.
    await run("psql", [
      "--no-psqlrc", "--set=ON_ERROR_STOP=1",
      "--dbname=" + fixtureUrl.toString(),
      "--file=" + path.resolve(process.cwd(), "src/routes/fixtures/pre-0020-received-calendar-date.sql"),
    ], options);
    // Validate the composed historical fixture before declaring its manifest
    // counts. A partial data import must fail here, not become a misleading
    // calendar-date migration failure after the destructive restore.
    const fixtureCounts = await fixturePool.query(`
      SELECT
        (SELECT count(*)::int FROM public.users) AS users,
        (SELECT count(*)::int FROM public.organizations) AS organizations,
        (SELECT count(*)::int FROM public.lab_memberships) AS memberships,
        (SELECT count(*)::int FROM public.cases) AS cases,
        (SELECT count(*)::int FROM public.invoices) AS invoices
    `);
    expect(fixtureCounts.rows).toEqual([{
      users: 1, organizations: 2, memberships: 1, cases: 2, invoices: 0,
    }]);
    const fixtureCases = await fixturePool.query(`
      SELECT c.id, c.case_number,
        to_char(c.received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS received_utc,
        lab.id AS lab_id, lab.type AS lab_type,
        practice.id AS practice_id, practice.type AS practice_type,
        u.id AS created_by, c.deleted_at
      FROM public.cases c
      LEFT JOIN public.organizations lab ON lab.id = c.lab_organization_id
      LEFT JOIN public.organizations practice ON practice.id = c.provider_organization_id
      LEFT JOIN public.users u ON u.id = c.created_by_user_id
      ORDER BY c.case_number
    `);
    expect(fixtureCases.rows).toEqual([
      {
        id: "legacy-received-minus12",
        case_number: "LEGACY-UTC-MINUS-12",
        received_utc: "2026-01-02T00:30:00.000000",
        lab_id: "legacy-received-lab", lab_type: "lab",
        practice_id: "legacy-received-provider", practice_type: "provider",
        created_by: "legacy-received-user", deleted_at: null,
      },
      {
        id: "legacy-received-plus14",
        case_number: "LEGACY-UTC-PLUS-14",
        received_utc: "2026-01-02T23:30:00.000000",
        lab_id: "legacy-received-lab", lab_type: "lab",
        practice_id: "legacy-received-provider", practice_type: "provider",
        created_by: "legacy-received-user", deleted_at: null,
      },
    ]);
    const fixtureMemberships = await fixturePool.query(`
      SELECT lm.user_id, lm.lab_id, lm.role, lm.status, lm.deleted_at
      FROM public.lab_memberships lm
      JOIN public.users u ON u.id = lm.user_id
      JOIN public.organizations lab ON lab.id = lm.lab_id AND lab.type = 'lab'
    `);
    expect(fixtureMemberships.rows).toEqual([{
      user_id: "legacy-received-user", lab_id: "legacy-received-lab",
      role: "admin", status: "active", deleted_at: null,
    }]);
    const fixtureColumns = await fixturePool.query(`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND ((table_name = 'cases' AND column_name = 'received_at')
          OR (table_name = 'case_restorations' AND column_name IN
            ('implant_retention', 'implant_manufacturer', 'implant_platform_notes')))
    `);
    expect(fixtureColumns.rows).toEqual([{
      table_name: "cases", column_name: "received_at", data_type: "timestamp with time zone",
    }]);
    tableCount = Number((await fixturePool.query("SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")).rows[0].count);
    await fixturePool.end();
    fixturePool = null;
    await run(resolvePostgresTool("pg_dump"), ["--format=custom", `--file=${fixtureFile}`, fixtureUrl.toString()], options);
    dump = fs.readFileSync(fixtureFile);
  } finally {
    if (fixturePool) await fixturePool.end();
    if (created) await admin.query(`DROP DATABASE "${fixtureName}"`);
    fs.rmSync(root, { recursive: true, force: true });
  }
  const zip = new AdmZip();
  zip.addFile("manifest.json", Buffer.from(JSON.stringify({
    version: "2.0",
    schemaVersion: "2",
    appName: "LabTrax",
    exportedAt: "2026-01-03T00:00:00.000Z",
    exportedBy: "pre-0020-fixture",
    dbFormat: "pg_dump:custom",
    userCount: 1,
    orgCount: 2,
    caseCount: 2,
    invoiceCount: 0,
    tableCount,
  }, null, 2)));
  zip.addFile(
    "db/database.pgdump",
    dump,
  );
  return testEncryptBuffer(zip.toBuffer());
}

/**
 * Return the ordered phase sequence of an executeRestore call.
 * Reads backupLib.getRestoreHistory() after the restore settles — the history
 * is appended synchronously as each phase is entered, so every phase (including
 * brief ones like clearing_sessions) is captured deterministically, unlike a
 * poll of getRestoreState() which can skip a fast phase under load.
 */
async function capturePhases(
  restorePromise: Promise<unknown>,
): Promise<string[]> {
  // Wait for the restore to settle, then read the authoritative phase history
  // recorded synchronously inside setRestorePhase. Polling getRestoreState()
  // between setImmediate yields can miss a phase whose only await (e.g. the
  // clearing_sessions orphan DELETE) resolves before the poll runs again —
  // that race made this flaky under full-suite concurrency.
  await restorePromise.catch(() => { /* phase=error is recorded in history */ });
  return backupLib.getRestoreHistory();
}

// ── module refs (populated in beforeAll) ─────────────────────────────────────

let dbMod: typeof import("@workspace/db");
let appMod: { default: import("express").Express };
let backupLib: typeof import("../lib/backup.js");

// ── cross-process suite lock ─────────────────────────────────────────────────
// When the Run-button aggregate fires, rel-backup-restore and rel-api-tests
// both execute this file against the same shared dev DB at the same time. Two
// restore pipelines racing produce false failures: "Case count mismatch"
// (one run's cleanup deletes rows between the other run's backup and its
// post-restore validation) and user_sessions_token_hash_unique 23505
// collisions (both runs' restoreSnapshotNow re-inserts race each other).
// A session-level PG advisory lock serializes the whole suite across
// processes; the second runner simply waits its turn. The lock is held on a
// dedicated pooled connection for the lifetime of the suite and is released
// in afterAll (or automatically by PG if the process dies).
const SUITE_LOCK_SQL_ACQUIRE =
  "SELECT pg_advisory_lock(1742068800, hashtext('backup-restore-suite'))";
const SUITE_LOCK_SQL_RELEASE =
  "SELECT pg_advisory_unlock(1742068800, hashtext('backup-restore-suite'))";
let suiteLockClient: import("pg").PoolClient | null = null;

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
    requireIsolatedRestoreTest();
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-backup-restore";

    dbMod      = await import("@workspace/db");
    appMod     = await import("../app.js");
    backupLib  = await import("../lib/backup.js");

    // Serialize the entire suite across concurrent test processes BEFORE any
    // DB rows are created or swept. pg_advisory_lock blocks until the other
    // runner (if any) releases in its afterAll, so the generous timeout on
    // this hook covers a full run of the suite by another workflow.
    const dbPool = (dbMod as any).pool as import("pg").Pool;
    suiteLockClient = await dbPool.connect();
    // The pool sets statement_timeout=30s, but pg_advisory_lock's blocking
    // wait counts as statement execution — waiting for another workflow's
    // full suite run would be killed mid-wait. Lift the limit on this one
    // session (it only ever runs the lock/unlock statements).
    await suiteLockClient.query("SET statement_timeout = 0");
    await suiteLockClient.query(SUITE_LOCK_SQL_ACQUIRE);

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
    // Generous timeout: pg_advisory_lock blocks until any concurrent runner
    // of this suite (rel-api-tests vs rel-backup-restore) finishes and
    // releases in its afterAll — that can take a few minutes under load.
  }, 600_000);

  afterAll(async () => {
    if (!dbMod) return; // Isolation guard refused before any DB was imported.
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

    // Release the cross-process suite lock last, after all cleanup, so the
    // next runner starts from a clean DB state. PG releases session-level
    // advisory locks automatically if this process dies before reaching here.
    if (suiteLockClient) {
      try {
        await suiteLockClient.query(SUITE_LOCK_SQL_RELEASE);
      } catch { /* released on disconnect anyway */ }
      suiteLockClient.release();
      suiteLockClient = null;
    }
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
      // Override the filesystem scan so the fail-fast guard (attachmentRowCount > 0 &&
      // fileCount === 0) does not fire on the dev DB which has real attachment rows but
      // an empty uploads/case-media dir in the test environment.
      backupLib._setUploadInspectionForTests({
        caseMedia:     { exists: true, fileCount: 1, totalBytes: 1024 },
        profilePhotos: { exists: false, fileCount: 0, totalBytes: 0 },
      });
      try {
        const { buffer } = await backupLib.buildBackupZipBuffer("test-backup-content");
        const zipBuffer = backupLib.decryptBuffer(buffer);
        const zip = new AdmZip(zipBuffer);
        const raw = zip.getEntry("manifest.json")!.getData().toString("utf8");
        manifest = JSON.parse(raw) as Record<string, unknown>;
      } finally {
        backupLib._setUploadInspectionForTests(null);
      }
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
          // are no longer needed.
          // Also skip unique_violation (23505) on user_sessions_token_hash_unique:
          // the validation gate runs this file in TWO parallel vitest instances
          // (rel-api-tests + rel-backup-restore) against the shared dev DB, so
          // another instance's login/refresh rotation can re-insert the same
          // token under a different session id between our snapshot SELECT and
          // this safety-net re-insert. ON CONFLICT (id) DO NOTHING only covers
          // id collisions, not the token_hash unique index. The live row wins;
          // our stale snapshot copy is not needed.  Re-throw anything else.
          if (e.code !== "23503" && e.code !== "23505") throw e;
        }
      }
    }

    async function restoreStartingBackupSafely(
      startingBackup: Buffer | null,
      label: string,
      restore: (buffer: Buffer, label: string) => Promise<unknown>,
      primaryTestFailed: boolean,
    ) {
      if (!startingBackup) return;

      const cleanupErrors: unknown[] = [];
      try {
        await restore(startingBackup, label);
      } catch (error) {
        cleanupErrors.push(error);
      }

      // Try to recover the session snapshot even when the database restore
      // failed; do not let one cleanup failure skip the remaining cleanup.
      try {
        await restoreSnapshotNow();
      } catch (error) {
        cleanupErrors.push(error);
      }

      if (cleanupErrors.length === 0) return;
      if (primaryTestFailed) {
        for (const error of cleanupErrors) {
          console.error(
            `Starting-state cleanup failed (${label}); preserving the primary test failure.`,
            error,
          );
        }
        return;
      }

      if (cleanupErrors.length === 1) throw cleanupErrors[0];
      throw new AggregateError(cleanupErrors, `Starting-state cleanup failed (${label}).`);
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
      // Same seam as tests 1–7: prevent the fail-fast guard from firing when the
      // dev DB has attachment rows but uploads/case-media is empty in CI/test env.
      backupLib._setUploadInspectionForTests({
        caseMedia:     { exists: true, fileCount: 1, totalBytes: 1024 },
        profilePhotos: { exists: false, fileCount: 0, totalBytes: 0 },
      });
      try {
        const { buffer } = await backupLib.buildBackupZipBuffer("test-restore-pipeline");
        testBackupBuffer = buffer;
      } finally {
        backupLib._setUploadInspectionForTests(null);
      }
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
      // Derive token hashes from per-run random ids (not fixed strings) so
      // these rows never collide on a persistent dev DB — the gap-free
      // restore intentionally never truncates user_sessions, so rows from an
      // interrupted prior run can survive and a fixed token_hash would
      // violate user_sessions_token_hash_unique on re-run (same rule as
      // test 16 below).
      const sess11aId = rid("sess11a");
      const sess11bId = rid("sess11b");
      await expect(
        db.insert(userSessions).values([
          {
            id: sess11aId,
            userId: ownerId,
            tokenHash: createHash("sha256").update(sess11aId).digest("hex"),
            expiresAt: new Date(Date.now() + 60_000),
          },
          {
            id: sess11bId,
            userId: ownerId,
            tokenHash: createHash("sha256").update(sess11bId).digest("hex"),
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
      // Per-run random token hash — see the hermeticity note in test 11.
      const sess12Id = rid("sess12");
      await db.insert(userSessions).values({
        id: sess12Id,
        userId: ownerId,
        tokenHash: createHash("sha256").update(sess12Id).digest("hex"),
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
        // Derive the token hash from the per-run random id (not a fixed
        // string) so this row never collides on a persistent dev DB. Test 16
        // intentionally aborts the restore BEFORE the user_sessions TRUNCATE,
        // so unlike the other session tests its row is never cleared — a fixed
        // token_hash would violate user_sessions_token_hash_unique on re-run.
        tokenHash: createHash("sha256").update(sess16Id).digest("hex"),
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

    it("restores pre-migration received timestamps as their exact UTC calendar days through the API", async () => {
      backupLib._setUploadInspectionForTests({
        caseMedia: { exists: true, fileCount: 1, totalBytes: 1024 },
        profilePhotos: { exists: false, fileCount: 0, totalBytes: 0 },
      });
      childProcessMockState.useRealCommands = true;
      childProcessMockState.realPgRestoreResults = [];
      let startingBackup: Buffer | null = null;
      let primaryTestFailed = false;
      try {
        startingBackup = (await backupLib.buildBackupZipBuffer(
          "test-legacy-received-date-starting-state",
        )).buffer;

        const restoreResult = await backupLib.executeRestore(
          await buildLegacyReceivedDateBackup(),
          "test-legacy-received-date",
        ).catch((error) => {
          const importResult = childProcessMockState.realPgRestoreResults.at(-1);
          expect(importResult?.code, importResult?.stderr).toBe(0);
          throw error;
        });
        expect(restoreResult.compatibilityUpgrades).toContain(
          "cases.received_at:timestamptz-to-date",
        );
        const fixtureRestore = childProcessMockState.realPgRestoreResults.at(-1);
        expect(fixtureRestore?.code, fixtureRestore?.stderr).toBe(0);
        expect(fixtureRestore?.stderr).toBe("");

        const auth = await import("../lib/auth.js");
        const sessionId = rid("legacy_received_session");
        const token = auth.signAccessToken("legacy-received-user", sessionId);
        const implantColumns = await (dbMod as any).pool.query(`
          SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'case_restorations'
            AND column_name IN ('implant_retention', 'implant_manufacturer', 'implant_platform_notes')
          ORDER BY column_name
        `);
        expect(implantColumns.rows.map((row: { column_name: string }) => row.column_name)).toEqual([
          "implant_manufacturer", "implant_platform_notes", "implant_retention",
        ]);
        await (dbMod as any).db.insert((dbMod as any).userSessions).values({
          id: sessionId,
          userId: "legacy-received-user",
          tokenHash: createHash("sha256").update(token).digest("hex"),
          expiresAt: new Date(Date.now() + 60_000),
        });

        const response = await request(appMod.default)
          .get("/api/cases")
          .set("Authorization", `Bearer ${token}`);

        expect(response.status).toBe(200);
        const restored = (response.body.data as Array<{
          caseNumber: string;
          receivedAt: string;
        }>).filter((row) => row.caseNumber.startsWith("LEGACY-UTC-"))
          .map(({ caseNumber, receivedAt }) => ({ caseNumber, receivedAt }))
          .sort((a, b) => a.caseNumber.localeCompare(b.caseNumber));
        expect(restored).toEqual([
          {
            caseNumber: "LEGACY-UTC-MINUS-12",
            receivedAt: "2026-01-02",
          },
          {
            caseNumber: "LEGACY-UTC-PLUS-14",
            receivedAt: "2026-01-02",
          },
        ]);
      } catch (error) {
        primaryTestFailed = true;
        throw error;
      } finally {
        try {
          await restoreStartingBackupSafely(
            startingBackup,
            "test-legacy-received-date-cleanup",
            (buffer, label) => backupLib.executeRestore(buffer, label),
            primaryTestFailed,
          );
        } finally {
          childProcessMockState.useRealCommands = false;
          backupLib._setUploadInspectionForTests(null);
        }
      }
    }, 300_000);

    it("preserves dated Rx history IDs, order, and submissions through a real backup restore", async () => {
      const { db, caseRxNoteEntries, userSessions } = dbMod as any;
      backupLib._setUploadInspectionForTests({
        caseMedia: { exists: true, fileCount: 1, totalBytes: 1024 },
        profilePhotos: { exists: false, fileCount: 0, totalBytes: 0 },
      });
      childProcessMockState.useRealCommands = true;
      childProcessMockState.realPgRestoreResults = [];

      const sessionId = rid("rx_restore_session");
      const auth = await import("../lib/auth.js");
      const token = auth.signAccessToken(ownerId, sessionId);
      await db.insert(userSessions).values({
        id: sessionId,
        userId: ownerId,
        tokenHash: createHash("sha256").update(token).digest("hex"),
        // This test performs a full backup and multiple DB-wide restores before
        // making the authenticated API assertion. Keep its session valid for
        // the restore duration; auth still checks the real token and session.
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });

      const firstEntry = {
        id: rid("rx_history"),
        caseId,
        noteText: "Use the original shade and confirm the margin.",
        scannedAt: new Date("2026-10-11T08:15:00.000Z"),
        provenance: "ai_reader",
        submissionId: rid("rx_submission"),
        payloadHash: createHash("sha256")
          .update("Use the original shade and confirm the margin.")
          .digest("hex"),
        createdAt: new Date("2026-10-11T08:15:02.000Z"),
      };
      const secondEntry = {
        id: rid("rx_history"),
        caseId,
        noteText: "Updated prescription: increase occlusal clearance.",
        scannedAt: new Date("2026-10-12T16:40:00.000Z"),
        provenance: "itero_import",
        submissionId: rid("rx_submission"),
        payloadHash: createHash("sha256")
          .update("Updated prescription: increase occlusal clearance.")
          .digest("hex"),
        createdAt: new Date("2026-10-12T16:40:03.000Z"),
      };

      let startingBackup: Buffer | null = null;
      let primaryTestFailed = false;
      try {
        startingBackup = (
          await backupLib.buildBackupZipBuffer("test-rx-history-starting-state")
        ).buffer;

        await db.insert(caseRxNoteEntries).values([firstEntry, secondEntry]);
        await db
          .update((dbMod as any).cases)
          .set({ rxNotes: secondEntry.noteText })
          .where(eq((dbMod as any).cases.id, caseId));

        const historyBackup = (
          await backupLib.buildBackupZipBuffer("test-rx-history-round-trip")
        ).buffer;

        // Prove the rows are coming back from the archive rather than simply
        // surviving in place before exercising pg_restore.
        await db
          .delete(caseRxNoteEntries)
          .where(eq(caseRxNoteEntries.caseId, caseId));
        expect(
          await db
            .select()
            .from(caseRxNoteEntries)
            .where(eq(caseRxNoteEntries.caseId, caseId)),
        ).toHaveLength(0);

        await safeExecuteRestore(historyBackup, "test-rx-history-round-trip");
        await restoreSnapshotNow();

        const restore = childProcessMockState.realPgRestoreResults.at(-1);
        expect(restore?.code, restore?.stderr).toBe(0);
        expect(restore?.stderr).toBe("");

        const readHistory = async () => {
          const response = await request(appMod.default)
            .get(`/api/cases/${caseId}`)
            .set("Authorization", `Bearer ${token}`);
          expect(response.status).toBe(200);
          return response.body.data.rxNoteEntries as Array<{
            id: string;
            noteText: string;
            scannedAt: string | null;
            provenance: string;
            submissionId: string | null;
            payloadHash: string | null;
            createdAt: string;
          }>;
        };

        const expected = [firstEntry, secondEntry].map((entry) => ({
          id: entry.id,
          noteText: entry.noteText,
          scannedAt: entry.scannedAt.toISOString(),
          provenance: entry.provenance,
          submissionId: entry.submissionId,
          payloadHash: entry.payloadHash,
          createdAt: entry.createdAt.toISOString(),
        }));

        expect(
          (await readHistory()).map((entry) => ({
            id: entry.id,
            noteText: entry.noteText,
            scannedAt: entry.scannedAt,
            provenance: entry.provenance,
            submissionId: entry.submissionId,
            payloadHash: entry.payloadHash,
            createdAt: entry.createdAt,
          })),
        ).toEqual(expected);
        expect(
          (await readHistory()).map((entry) => entry.id),
        ).toEqual([firstEntry.id, secondEntry.id]);

        const restoredRows = await db
          .select()
          .from(caseRxNoteEntries)
          .where(eq(caseRxNoteEntries.caseId, caseId));
        expect(restoredRows).toHaveLength(2);
        expect(new Set(restoredRows.map((entry: { id: string }) => entry.id)).size)
          .toBe(2);
      } catch (error) {
        primaryTestFailed = true;
        throw error;
      } finally {
        try {
          await restoreStartingBackupSafely(
            startingBackup,
            "test-rx-history-round-trip-cleanup",
            (buffer, label) => safeExecuteRestore(buffer, label),
            primaryTestFailed,
          );
        } finally {
          childProcessMockState.useRealCommands = false;
          backupLib._setUploadInspectionForTests(null);
        }
      }
    }, 300_000);
  });

  // ── History download endpoint (tests 21–22) ──────────────────────────────

  describe("History download endpoint (tests 21–22)", () => {
    let onedriveMod: typeof import("../lib/onedrive.js");
    let localRunId: number;
    let onedriveRunId: number;
    const fakeFileBytes = randomBytes(256);
    const fakeFileName = `backup-test-${Date.now()}.zip.enc`;

    beforeAll(async () => {
      onedriveMod = await import("../lib/onedrive.js");

      const db = (dbMod as any).db;
      const { backupRuns } = dbMod as any;

      // Insert a local-destination run (download should return 400)
      const [localRun] = await db
        .insert(backupRuns)
        .values({
          status: "success",
          destination: "local",
          path: "/tmp/fake-local-backup.zip.enc",
          fileName: "fake-local-backup.zip.enc",
          sizeBytes: 512,
          triggeredBy: "test-21",
          completedAt: new Date(),
        })
        .returning({ id: backupRuns.id });
      localRunId = localRun.id;

      // Insert an onedrive-destination run (download should return 200 via mock)
      const [onedriveRun] = await db
        .insert(backupRuns)
        .values({
          status: "success",
          destination: "onedrive",
          path: `https://1drv.ms/u/fake-link`,
          fileName: fakeFileName,
          sizeBytes: fakeFileBytes.length,
          triggeredBy: "test-22",
          completedAt: new Date(),
        })
        .returning({ id: backupRuns.id });
      onedriveRunId = onedriveRun.id;
    }, 60_000);

    afterAll(async () => {
      onedriveMod.setOneDriveFetchForTests(null);
      const db = (dbMod as any).db;
      const { backupRuns } = dbMod as any;
      const { inArray: _inArray } = await import("drizzle-orm");
      await db
        .delete(backupRuns)
        .where(_inArray(backupRuns.id, [localRunId, onedriveRunId].filter(Boolean)));
    });

    it("denies a lab administrator access to platform-wide backup history", async () => {
      const { db, users, userSessions } = dbMod as any;
      const authLib = await import("../lib/auth.js");
      const userId = rid("backup-history-lab-admin");
      const sessionId = rid("backup-history-session");
      const accessToken = authLib.signAccessToken(userId, sessionId);
      const tokenHash = createHash("sha256").update(accessToken).digest("hex");

      try {
        await db.insert(users).values({
          id: userId,
          username: `backuprestore_${userId}`,
          password: "doesnotmatter",
          userType: "lab",
          role: "admin",
        });
        await db.insert(userSessions).values({
          id: sessionId,
          userId,
          tokenHash,
          expiresAt: new Date(Date.now() + 60_000),
        });

        const denied = await request(appMod.default)
          .get("/api/admin/backup/history")
          .set("Authorization", `Bearer ${accessToken}`);
        expect(denied.status).toBe(403);

        const platformAdmin = await request(appMod.default)
          .get("/api/admin/backup/history")
          .set("X-Platform-Admin-Secret", PLATFORM_ADMIN_SECRET);
        expect(platformAdmin.status).toBe(200);
        expect(platformAdmin.body.ok).toBe(true);
      } finally {
        await db.delete(userSessions).where(eq(userSessions.id, sessionId));
        await db.delete(users).where(eq(users.id, userId));
      }
    });

    it("21. returns 400 for a non-OneDrive (local) backup run", async () => {
      const res = await request(appMod.default)
        .get(`/api/admin/backup/history/${localRunId}/download`)
        .set("X-Platform-Admin-Secret", PLATFORM_ADMIN_SECRET);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/only onedrive/i);
    });

    it.each([false, true])("22. downloads the recorded archive (stable item reference: %s)", async byId => {
      const { db, backupRuns } = dbMod as any;
      await db.update(backupRuns).set({
        path: byId ? onedriveMod.oneDriveItemPath("exact-renamed-item") : "https://1drv.ms/u/legacy",
      }).where(eq(backupRuns.id, onedriveRunId));
      // getOneDriveAccessToken checks REPLIT_CONNECTORS_HOSTNAME + REPL_IDENTITY
      // before calling gfetch.  Set them for the duration of this test so that
      // the env-var guard passes, then let the fetch override handle both the
      // connector-proxy lookup and the actual Graph download.
      const origHostname = process.env["REPLIT_CONNECTORS_HOSTNAME"];
      const origIdentity = process.env["REPL_IDENTITY"];
      process.env["REPLIT_CONNECTORS_HOSTNAME"] = "fake-connector-host.test";
      process.env["REPL_IDENTITY"] = "fake-repl-identity";

      // Stub the OneDrive fetch so the test never contacts the real Graph API.
      // The stub handles both: (1) the Replit connector-proxy token lookup, and
      // (2) the actual Microsoft Graph download request.
      onedriveMod.setOneDriveFetchForTests(async (url: string) => {
        if (url.includes("connector") || url.includes("connection")) {
          // Connector proxy: return a fake access token
          return {
            ok: true,
            status: 200,
            json: async () => ({
              items: [{ settings: { access_token: "fake-graph-token" } }],
            }),
            text: async () => "",
          };
        }
        // Microsoft Graph file download
        if (byId) {
          expect(url).toContain("/me/drive/items/exact-renamed-item/content");
          expect(url).not.toContain("/root:");
        } else {
          expect(url).toContain(`/${fakeFileName}:/content`);
        }
        return new Response(new Uint8Array(fakeFileBytes), {
          status: 200,
          headers: { "Content-Length": String(fakeFileBytes.length) },
        });
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let res: any;
      try {
        res = await request(appMod.default)
          .get(`/api/admin/backup/history/${onedriveRunId}/download`)
          .set("X-Platform-Admin-Secret", PLATFORM_ADMIN_SECRET)
          .buffer(true)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .parse((resp: any, cb: any) => {
            const chunks: Buffer[] = [];
            resp.on("data", (c: Buffer) => chunks.push(c));
            resp.on("end", () => cb(null, Buffer.concat(chunks)));
          });
      } finally {
        // Restore original env vars and clear the override
        if (origHostname === undefined) delete process.env["REPLIT_CONNECTORS_HOSTNAME"];
        else process.env["REPLIT_CONNECTORS_HOSTNAME"] = origHostname;
        if (origIdentity === undefined) delete process.env["REPL_IDENTITY"];
        else process.env["REPL_IDENTITY"] = origIdentity;
        onedriveMod.setOneDriveFetchForTests(null);
      }

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/octet-stream/);
      expect(res.headers["content-disposition"]).toContain(fakeFileName);
      expect(Buffer.from(res.body as Buffer).equals(fakeFileBytes)).toBe(true);
    });
  });

  // ── Media dirs + fail-fast guard (tests 23–28) ───────────────────────────

  describe("Media dirs + fail-fast guard (tests 23–28)", () => {
    let backupMod: typeof import("../lib/backup.js");
    const guardAttachmentId = rid("guard-att");

    beforeAll(async () => {
      backupMod = await import("../lib/backup.js");
      // Seed the row this guard needs. A clean restore test database does not
      // contain unrelated attachments from other users or previous test runs.
      const { db, caseAttachments } = dbMod as any;
      await db.insert(caseAttachments).values({
        id: guardAttachmentId,
        caseId,
        uploadedByUserId: ownerId,
        uploadedByOrganizationId: labOrgId,
        fileName: "missing-media.pdf",
        storageKey: `case-media/${guardAttachmentId}.pdf`,
        fileType: "application/pdf",
      });
    });

    afterAll(async () => {
      const { db, caseAttachments } = dbMod as any;
      await db.delete(caseAttachments).where(eq(caseAttachments.id, guardAttachmentId));
    });

    afterEach(() => {
      // Always clear the test seam after each test to avoid state bleed.
      backupMod._setUploadInspectionForTests(null);
    });

    it("23. buildBackupZipBuffer succeeds when media dir has files", async () => {
      backupMod._setUploadInspectionForTests({
        caseMedia:     { exists: true,  fileCount: 5,  totalBytes: 1024 * 500 },
        profilePhotos: { exists: true,  fileCount: 2,  totalBytes: 1024 * 100 },
      });
      const result = await backupMod.buildBackupZipBuffer("test-23");
      expect(result.buffer).toBeDefined();
      expect(result.uploadDirs.caseMedia.fileCount).toBe(5);
      expect(result.attachmentRowCount).toBeGreaterThanOrEqual(0);
    });

    it("24. buildBackupZipBuffer succeeds when media dir has files (guard does not fire)", async () => {
      // When fileCount > 0, the guard must not fire regardless of attachmentRowCount.
      backupMod._setUploadInspectionForTests({
        caseMedia:     { exists: true, fileCount: 10, totalBytes: 1024 * 1024 },
        profilePhotos: { exists: false, fileCount: 0, totalBytes: 0 },
      });
      const result = await backupMod.buildBackupZipBuffer("test-24");
      expect(result.buffer).toBeDefined();
      expect(result.uploadDirs.caseMedia.fileCount).toBe(10);
    });

    it("25. buildBackupZipBuffer throws when media dir is empty and DB has attachment rows", async () => {
      // Our seeded attachment row + an empty media directory triggers the guard.
      backupMod._setUploadInspectionForTests({
        caseMedia:     { exists: true, fileCount: 0, totalBytes: 0 },
        profilePhotos: { exists: false, fileCount: 0, totalBytes: 0 },
      });
      await expect(backupMod.buildBackupZipBuffer("test-25")).rejects.toThrow(/backup aborted/i);
    });

    it("26. backup manifest includes mediaFileCount and profilePhotoFileCount when media exists", async () => {
      backupMod._setUploadInspectionForTests({
        caseMedia:     { exists: true, fileCount: 3,  totalBytes: 300_000 },
        profilePhotos: { exists: true, fileCount: 1,  totalBytes: 50_000 },
      });
      const { buffer } = await backupMod.buildBackupZipBuffer("test-26");
      const AdmZip = (await import("adm-zip")).default;
      const zip = new AdmZip(
        (await import("../lib/backup.js")).decryptBuffer(buffer),
      );
      const manifestEntry = zip.getEntry("manifest.json");
      expect(manifestEntry).toBeTruthy();
      const manifest = JSON.parse(manifestEntry!.getData().toString("utf8")) as Record<string, unknown>;
      expect(typeof manifest.mediaFileCount).toBe("number");
      expect(manifest.mediaFileCount).toBe(3);
      expect(typeof manifest.profilePhotoFileCount).toBe("number");
      expect(manifest.profilePhotoFileCount).toBe(1);
      expect(typeof manifest.attachmentRowCount).toBe("number");
    });

    it("27. streamBackupDownload reports missing originals without dropping their database references", async () => {
      // The explicitly seeded attachment row is still present.
      // Missing originals are disclosed in an encrypted partial archive, never
      // mislabeled complete or removed from the database.
      // The streaming route is POST /api/admin/backup/generate (not GET /download).
      backupMod._setUploadInspectionForTests({
        caseMedia:     { exists: true, fileCount: 0, totalBytes: 0 },
        profilePhotos: { exists: false, fileCount: 0, totalBytes: 0 },
      });
      const res = await request(appMod.default)
        .post("/api/admin/backup/generate")
        .set("X-Platform-Admin-Secret", PLATFORM_ADMIN_SECRET)
        .buffer(true)
        .parse((response: any, done: any) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => done(null, Buffer.concat(chunks)));
          response.on("error", done);
        });
      expect(res.status).toBe(200);
      expect(res.headers["x-backup-archive-kind"]).toBe("partial-non-production");
      expect(Number(res.headers["x-backup-missing-file-count"])).toBeGreaterThan(0);
      const zip = new AdmZip(backupMod.decryptBuffer(res.body));
      expect(JSON.parse(zip.readAsText("missing-files.json")).missingReferences)
        .toContain(`case-media/${guardAttachmentId}.pdf`);
      const { db, caseAttachments } = dbMod as any;
      expect(await db.select().from(caseAttachments)
        .where(eq(caseAttachments.id, guardAttachmentId))).toHaveLength(1);
    });

    it("28. executeRestore extracts profile-photos/ entries from backup ZIP", async () => {
      const pathMod = require("path") as typeof import("path");
      const fs = require("fs") as typeof import("fs");

      // Place a real file on disk BEFORE building the backup so that archiver
      // includes it natively (without any post-hoc adm-zip mutation, which
      // cannot read data-descriptor entries produced by archiver).
      const profilePhotosDir = pathMod.resolve(process.cwd(), "uploads", "profile-photos");
      fs.mkdirSync(profilePhotosDir, { recursive: true });
      const sourcePhotoPath = pathMod.join(profilePhotosDir, "test-photo-28.jpg");
      const fakePhotoBytes = Buffer.from("fake-photo-content-28");
      fs.writeFileSync(sourcePhotoPath, fakePhotoBytes);

      // caseMedia.fileCount must be > 0 so the fail-fast guard does not fire.
      // Let inspectUploadDirs scan the real directories (profilePhotos.exists=true
      // since we just created the file).
      backupMod._setUploadInspectionForTests({
        caseMedia:     { exists: true, fileCount: 1, totalBytes: 1024 },
        profilePhotos: { exists: true, fileCount: 1, totalBytes: fakePhotoBytes.length },
      });
      const { buffer } = await backupMod.buildBackupZipBuffer("test-28-build");
      backupMod._setUploadInspectionForTests(null);

      // Remove the source photo so executeRestore must put it back via extraction.
      fs.unlinkSync(sourcePhotoPath);

      // executeRestore runs pg_restore using the real dump in the ZIP.
      await backupMod.executeRestore(buffer, "test-28");

      const extracted =
        fs.existsSync(profilePhotosDir) &&
        fs.readdirSync(profilePhotosDir).includes("test-photo-28.jpg");
      expect(extracted).toBe(true);

      if (extracted) {
        const content = fs.readFileSync(
          pathMod.join(profilePhotosDir, "test-photo-28.jpg"),
        );
        expect(content.equals(fakePhotoBytes)).toBe(true);
      }
    });

    it("29. runLocalBackup writes an explicitly partial archive with a missing-file inventory", async () => {
      const pathMod = require("path") as typeof import("path");
      const fs = require("fs") as typeof import("fs");
      const osMod = require("os") as typeof import("os");

      const destDir = fs.mkdtempSync(pathMod.join(osMod.tmpdir(), "labtrax-local-dest-"));
      try {
        const result = await backupMod.runLocalBackup("test-29", destDir);
        expect(result).toMatchObject({
          destination: "local", archiveKind: "partial-non-production", partialFailure: true,
        });
        expect(result.warnings).toMatch(/not a complete recovery point/i);
        expect(fs.readdirSync(destDir)).toEqual([result.fileName]);
        const bytes = fs.readFileSync(result.path!);
        expect(bytes.length).toBe(result.size);
        const zip = new AdmZip(backupMod.decryptBuffer(bytes));
        expect(zip.getEntry("db/database.pgdump")).toBeTruthy();
        const missing = JSON.parse(zip.readAsText("missing-files.json"));
        expect(missing.missingFileCount).toBeGreaterThan(0);
        expect(missing.missingReferences).toContain(`case-media/${guardAttachmentId}.pdf`);
        const { db, caseAttachments } = dbMod as any;
        expect(await db.select().from(caseAttachments)
          .where(eq(caseAttachments.id, guardAttachmentId))).toHaveLength(1);
      } finally {
        fs.rmSync(destDir, { recursive: true, force: true });
      }
    });

    it("30. runLocalBackup cleans up its temp working directory", async () => {
      const pathMod = require("path") as typeof import("path");
      const fs = require("fs") as typeof import("fs");
      const osMod = require("os") as typeof import("os");

      const countTempDirs = () =>
        fs.readdirSync(osMod.tmpdir()).filter((n) => n.startsWith("labtrax-backup-")).length;

      const before = countTempDirs();
      const destDir = fs.mkdtempSync(pathMod.join(osMod.tmpdir(), "labtrax-local-dest-"));
      try {
        const result = await backupMod.runLocalBackup("test-30", destDir);
        expect(result.archiveKind).toBe("partial-non-production");
        expect(result.partialFailure).toBe(true);
        expect(fs.readdirSync(destDir)).toEqual([result.fileName]);
        // A leaked temp archive would fill the deployment disk over time.
        expect(countTempDirs()).toBe(before);
      } finally {
        fs.rmSync(destDir, { recursive: true, force: true });
      }
    });
  });

  // No transport failure permits silently dropping a durable file class.
  describe("OneDrive full-content failure policy (tests 29–32)", () => {
    let backupMod: typeof import("../lib/backup.js");
    let onedriveMod: typeof import("../lib/onedrive.js");
    let origHostname: string | undefined;
    let origIdentity: string | undefined;
    let origMinBytes: string | undefined;

    beforeAll(async () => {
      backupMod = await import("../lib/backup.js");
      onedriveMod = await import("../lib/onedrive.js");
      origHostname = process.env["REPLIT_CONNECTORS_HOSTNAME"];
      origIdentity = process.env["REPL_IDENTITY"];
      process.env["REPLIT_CONNECTORS_HOSTNAME"] = "fake-connector-host.test";
      process.env["REPL_IDENTITY"] = "fake-repl-identity";
      // These fixtures build deliberately tiny archives from a schema-only
      // database. Production refuses anything under a megabyte as a
      // placeholder, so lower the floor here to keep testing the fallback.
      origMinBytes = process.env["BACKUP_MIN_PLAUSIBLE_BYTES"];
      process.env["BACKUP_MIN_PLAUSIBLE_BYTES"] = "1";
    });

    afterAll(() => {
      if (origMinBytes === undefined) delete process.env["BACKUP_MIN_PLAUSIBLE_BYTES"];
      else process.env["BACKUP_MIN_PLAUSIBLE_BYTES"] = origMinBytes;
      if (origHostname === undefined) delete process.env["REPLIT_CONNECTORS_HOSTNAME"];
      else process.env["REPLIT_CONNECTORS_HOSTNAME"] = origHostname;
      if (origIdentity === undefined) delete process.env["REPL_IDENTITY"];
      else process.env["REPL_IDENTITY"] = origIdentity;
    });

    afterEach(() => {
      backupMod._setUploadInspectionForTests(null);
      onedriveMod.setOneDriveFetchForTests(null);
    });

    // Always answers the connector-proxy token lookup. Fails the FIRST
    // createUploadSession call with HTTP 507 (simulating the full ZIP, with
    // profile-photos, tripping up the upload); when `failEveryUploadSession`
    // is set, every createUploadSession call fails instead. Any chunk PUT
    // that follows a successful session responds as a completed upload.
    function makeFlakyFetch(opts: {
      failEveryUploadSession?: boolean;
      skipFirstFailure?: boolean;
      readbackSize?: number | null;
      readbackId?: string;
    } = {}) {
      let sessionCallCount = 0;
      let lastUploadedBytes = 4096;
      let uploadedName = "";
      return async (url: string, init?: { body?: string | Uint8Array }) => {
        if (url.includes("/children?")) return {
          ok: true, status: 200, json: async () => ({ value: [] }), text: async () => "",
        };
        if (url.includes("connector") || url.includes("connection")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ items: [{ settings: { access_token: "fake-graph-token" } }] }),
            text: async () => "",
          };
        }
        if (url.includes("createUploadSession")) {
          sessionCallCount++;
          uploadedName = JSON.parse(String(init?.body)).item.name;
          if (opts.failEveryUploadSession || (sessionCallCount === 1 && !opts.skipFirstFailure)) {
            return {
              ok: false,
              status: 507,
              json: async () => ({}),
              text: async () => "Insufficient storage",
            };
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({ uploadUrl: "https://fake-upload.test/session-2" }),
            text: async () => "",
          };
        }
        // Post-upload read-back: the backup refuses to call a run successful
        // until Microsoft Graph shows the stored item, so answer the item
        // lookup with the file the upload claims to have written.
        if (url.includes("/me/drive/items/") && url.includes("$select=")) {
          const name = uploadedName;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              id: opts.readbackId ?? "fake-item-id",
              name,
              size: opts.readbackSize === null ? undefined : opts.readbackSize ?? lastUploadedBytes,
              createdDateTime: new Date().toISOString(),
              webUrl: "https://fake.example/backup.zip.enc",
            }),
            text: async () => "",
          };
        }
        // Chunk PUT to the uploadUrl — our test buffers are tiny (a single
        // chunk), so respond as the completed-item response.
        lastUploadedBytes = init?.body ? (init.body as Uint8Array).length : 4096;
        return {
          ok: true,
          status: 201,
          json: async () => ({ id: "fake-item-id", name: uploadedName, size: lastUploadedBytes, webUrl: "https://fake.example/backup.zip.enc" }),
          text: async () => "",
        };
      };
    }

    it("29. refuses to upload a reduced archive when profile photos are present", async () => {
      backupMod._setUploadInspectionForTests({
        caseMedia: { exists: true, fileCount: 3, totalBytes: 300_000 },
        profilePhotos: { exists: true, fileCount: 2, totalBytes: 50_000 },
      });
      onedriveMod.setOneDriveFetchForTests(makeFlakyFetch());
      await expect(backupMod.runOneDriveBackup("test-29")).rejects.toThrow(/HTTP 507/);
    });

    it("30. preserves the hard upload failure when no profile photos are present", async () => {
      backupMod._setUploadInspectionForTests({
        caseMedia: { exists: true, fileCount: 3, totalBytes: 300_000 },
        profilePhotos: { exists: false, fileCount: 0, totalBytes: 0 },
      });
      onedriveMod.setOneDriveFetchForTests(
        makeFlakyFetch({ failEveryUploadSession: true }),
      );
      await expect(backupMod.runOneDriveBackup("test-30")).rejects.toThrow(/HTTP 507/);
    });

    it("31. does not report success when the uploaded archive cannot be confirmed", async () => {
      backupMod._setUploadInspectionForTests({
        caseMedia: { exists: true, fileCount: 3, totalBytes: 300_000 },
        profilePhotos: { exists: true, fileCount: 2, totalBytes: 50_000 },
      });
      onedriveMod.setOneDriveFetchForTests(
        makeFlakyFetch({ skipFirstFailure: true, readbackSize: 1 }),
      );
      await expect(backupMod.runOneDriveBackup("test-31")).rejects.toThrow(
        /archive|size|confirm|match/i,
      );
    });

    it("32. the confirmed success path records the exact OneDrive item", async () => {
      let sessionCalls = 0;
      let uploadedBytes = 4096;
      let uploadedName = "";
      onedriveMod.setOneDriveFetchForTests(
        async (url: string, init?: { body?: string | Uint8Array }) => {
        if (url.includes("/children?")) return {
          ok: true, status: 200, json: async () => ({ value: [] }), text: async () => "",
        };
        if (url.includes("connector") || url.includes("connection")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ items: [{ settings: { access_token: "fake-graph-token" } }] }),
            text: async () => "",
          };
        }
        if (url.includes("createUploadSession")) {
          sessionCalls++;
          uploadedName = JSON.parse(String(init?.body)).item.name.replace(".zip.enc", ".zip 22.enc");
          return {
            ok: true,
            status: 200,
            json: async () => ({ uploadUrl: "https://fake-upload.test/session-ok" }),
            text: async () => "",
          };
        }
        // Post-upload read-back through Graph: the run is only a success if
        // the drive itself reports the stored item.
        if (url.includes("/me/drive/items/") && url.includes("$select=")) {
          const name = uploadedName;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              id: "fake-ok-item-id",
              name,
              size: uploadedBytes,
              createdDateTime: new Date().toISOString(),
              webUrl: "https://fake.example/backup-ok.zip.enc",
            }),
            text: async () => "",
          };
        }
        uploadedBytes = init?.body ? (init.body as Uint8Array).length : 4096;
        return {
          ok: true,
          status: 201,
          json: async () => ({ id: "fake-ok-item-id", name: uploadedName, size: uploadedBytes, webUrl: "https://fake.example/backup-ok.zip.enc" }),
          text: async () => "",
        };
        },
      );

      const result = await backupMod.runBackup("test-32", "onedrive");
      expect(result.path).toBe(onedriveMod.oneDriveItemPath("fake-ok-item-id"));
      expect(result.fileName).toBe(uploadedName);
      expect(result.fileName).toMatch(/\.zip 22\.enc$/);
      const { db, backupRuns } = dbMod as any;
      const [history] = await db.select().from(backupRuns).where(eq(backupRuns.triggeredBy, "test-32"));
      expect(history).toMatchObject({
        status: "success", fileName: uploadedName,
        path: onedriveMod.oneDriveItemPath("fake-ok-item-id"), sizeBytes: uploadedBytes,
      });

      expect(result.partialFailure).toBeFalsy();
      expect(result.warnings ?? null).toBeNull();
      expect(sessionCalls).toBe(1);
    });

    it.each([
      { readbackSize: null },
      { readbackSize: 1 },
      { readbackId: "older-customer-item" },
    ])("refuses an unconfirmed archive without deleting or pruning anything: %s", async mismatch => {
      backupMod._setUploadInspectionForTests({
        caseMedia: { exists: true, fileCount: 0, totalBytes: 0 },
        profilePhotos: { exists: true, fileCount: 0, totalBytes: 0 },
      });
      const fetch = makeFlakyFetch({ skipFirstFailure: true, ...mismatch });
      const requests: string[] = [];
      onedriveMod.setOneDriveFetchForTests(async (url, init) => {
        requests.push(`${init?.method ?? "GET"} ${url}`);
        return fetch(url, init);
      });
      await expect(backupMod.runOneDriveBackup("ci:unconfirmed-cloud-item")).rejects.toThrow(/unconfirmed|invalid/);
      expect(requests.some(request => request.startsWith("DELETE ") || request.includes("/children?"))).toBe(false);
    });
  });
});
