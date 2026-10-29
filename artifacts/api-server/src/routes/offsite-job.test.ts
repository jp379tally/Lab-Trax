/**
 * The off-site backup job — the timer that actually produces production's
 * archives.
 *
 * The editable interval schedule is not what runs on the deployed server;
 * this job is. So it has to make the same archive-kind decision and carry the
 * same run deadline as the interval schedule, or a fifteen-minute cadence
 * uploads a ~591 MB media archive 96 times a day and a wedged upload holds
 * the in-flight guard against every later tick. Testing the decision helper
 * alone proved nothing about this path.
 *
 * Gate-only (scripts/run-isolated-backup-restore.sh): it takes real dumps,
 * which are small against the disposable gate database and minutes long
 * against the shared dev one. The OneDrive module is mocked, so nothing is
 * uploaded or pruned anywhere.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import AdmZip from "adm-zip";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { requireIsolatedRestoreTest } from "../lib/restore-test-isolation.js";

vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/backup-production-source", () => ({
  verifyProductionBackupSource: vi.fn(async () => "a".repeat(64)),
}));
vi.mock("../lib/mail.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/mail.js")>()),
  sendBackupNotificationEmail: vi.fn().mockResolvedValue(undefined),
  sendBackupStaleAlertEmail: vi.fn().mockResolvedValue(undefined),
}));

// Hermetic staging: no GCS writes, while exercising real archive encryption,
// complete-recovery manifests and the new bounded-range transfer contract.
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

const fake = vi.hoisted(() => ({
  uploads: [] as Array<{ fileName: string; signal: AbortSignal | undefined; size: number }>,
  stored: new Map<
    string,
    { id: string; name: string; size: number; createdDateTime: string; webUrl: string | null }
  >(),
  archiveBytes: new Map<string, Buffer>(),
  // Incremental baseline objects live in separate Graph folders from archives.
  protectionObjects: new Map<string, {
    id: string; name: string; size: number; createdDateTime: string;
    webUrl: null; driveId: string; contentTag: string; bytes: Buffer;
  }>(),
  mediaObjects: new Map<string, Buffer>(),
  privateObjects: new Map<string, Buffer>(),
  restoredObjects: new Map<string, Buffer>(),
  failMediaCopy: false,
  failAfterBlockedMediaCopy: false,
  blockMediaCopy: false,
  mediaCopyStarted: null as null | (() => void),
  mediaCopyGate: null as null | Promise<void>,
}));

// These bytes and the signature attestation are synthetic. They exercise the
// archive's identity contract, not native signing or a deployed production pair.
const SYNTHETIC_SOURCE_REVISION = "c".repeat(40);
const SYNTHETIC_INSTALLER = Buffer.from("synthetic signed-installer fixture");
const SYNTHETIC_RELEASE_IDENTITY = {
  schemaVersion: 1,
  version: "0.0.0-test",
  sourceRevision: SYNTHETIC_SOURCE_REVISION,
  signatureVerification: "verified-installer",
  artifact: {
    fileName: "LabTrax-Setup.exe",
    size: SYNTHETIC_INSTALLER.length,
    sha256: createHash("sha256").update(SYNTHETIC_INSTALLER).digest("hex"),
  },
};

function seedSyntheticReleaseIdentity() {
  fake.privateObjects.set("desktop-installer/LabTrax-Setup.exe", SYNTHETIC_INSTALLER);
  fake.privateObjects.set("desktop-installer/release-identity.json",
    Buffer.from(JSON.stringify(SYNTHETIC_RELEASE_IDENTITY)));
}

vi.mock("../lib/case-media-object-storage.js", () => ({
  caseMediaObjectStorageAvailable: () => true,
  listCaseMediaBackupObjects: vi.fn(async () => {
    if (fake.failMediaCopy) throw new Error("test App Storage read failure");
    const fs = await import("node:fs/promises");
    if (fake.blockMediaCopy) {
      fake.mediaCopyStarted?.();
      await fake.mediaCopyGate;
      if (fake.failAfterBlockedMediaCopy) {
        throw new Error("test full archive media staging timeout");
      }
    }
    return [...fake.mediaObjects].map(([relativeName, bytes]) => ({
      relativeName,
      size: bytes.length,
      copyTo: async (target: string) => { await fs.writeFile(target, bytes); },
    }));
  }),
  listPrivateBackupObjects: vi.fn(async () => {
    if (fake.failMediaCopy) throw new Error("test App Storage read failure");
    if (fake.blockMediaCopy) {
      fake.mediaCopyStarted?.();
      await fake.mediaCopyGate;
      if (fake.failAfterBlockedMediaCopy) throw new Error("test full archive media staging timeout");
    }
    const fs = await import("node:fs/promises");
    return [
      ...[...fake.mediaObjects].map(([name, bytes]) => [`case-media/${name}`, bytes] as const),
      ...fake.privateObjects,
    ].map(([relativeName, bytes]) => ({
      relativeName, size: bytes.length, generation: "1", modifiedAt: "2000-01-01T00:00:00Z",
      metadata: { contentType: "application/octet-stream", metadata: { visibility: "private" } },
      copyTo: async (target: string) => { await fs.writeFile(target, bytes); },
      openStream: () => Readable.from([bytes]),
    }));
  }),
  openPrivateBackupObject: vi.fn(async (name: string) => {
    const bytes = fake.restoredObjects.get(name);
    if (!bytes) return null;
    return {
      relativeName: name, size: bytes.length, generation: "1",
      modifiedAt: "2000-01-01T00:00:00Z",
      openStream: () => Readable.from([bytes]),
      copyTo: async (target: string) => { await writeFile(target, bytes); },
    };
  }),
  restorePrivateBackupObject: vi.fn(async (name: string, bytes: Buffer) => {
    fake.restoredObjects.set(name, bytes);
  }),
  restorePrivateBackupObjectStream: vi.fn(async (name: string, stream: AsyncIterable<Buffer>) => {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    fake.restoredObjects.set(name, Buffer.concat(chunks));
  }),
}));

vi.mock("../lib/onedrive.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/onedrive.js")>();
  return {
    ...actual,
    isOneDriveConnectorAvailable: () => true,
    uploadBackupToOneDrive: vi.fn(async (bytes: Buffer, name: string,
      options: { folder?: string; signal?: AbortSignal } = {}) => {
      options.signal?.throwIfAborted();
      if (!options.folder?.includes("/production-content-v1/")) {
        throw new Error("Unexpected synthetic protection upload namespace");
      }
      const key = `${options.folder}\0${name}`;
      const digest = createHash("sha256").update(bytes).digest("hex");
      const item = { id: createHash("sha256").update(key).digest("hex"), name,
        size: bytes.length, createdDateTime: new Date().toISOString(), webUrl: null,
        driveId: "synthetic-protection-drive", contentTag: digest, bytes: Buffer.from(bytes) };
      fake.protectionObjects.set(key, item);
      return { itemId: item.id, fileName: name, size: item.size, webUrl: null, folder: options.folder };
    }),
    downloadFileFromOneDrive: vi.fn(async (name: string, size: number, folder?: string,
      itemId?: string, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      const item = fake.protectionObjects.get(`${folder}\0${name}`);
      if (!item || item.id !== itemId || item.size !== size) {
        throw new Error("Synthetic protection download identity mismatch");
      }
      return Readable.from([Buffer.from(item.bytes)]);
    }),
    deleteOneDriveBackupFile: vi.fn(async (itemId: string) => {
      const entry = [...fake.protectionObjects].find(([, item]) => item.id === itemId);
      if (!entry) throw new Error("Unexpected synthetic protection deletion");
      fake.protectionObjects.delete(entry[0]);
    }),
    uploadBackupSourceToOneDrive: vi.fn(
      async (source: { size: number; readChunk(offset: number, length: number): Promise<Buffer> },
        fileName: string, options: { signal?: AbortSignal } = {}) => {
        const chunks: Buffer[] = [];
        for (let offset = 0; offset < source.size; offset += 5 * 1024 * 1024) {
          chunks.push(await source.readChunk(offset, Math.min(5 * 1024 * 1024, source.size - offset)));
        }
        fake.archiveBytes.set(fileName, Buffer.concat(chunks));
        const item = { id: `item_${fake.stored.size + 1}`, name: fileName, size: source.size,
          createdDateTime: new Date().toISOString(), webUrl: null };
        fake.stored.set(item.id, item);
        fake.uploads.push({ fileName, signal: options.signal, size: source.size });
        return { itemId: item.id, fileName, size: source.size, webUrl: null, folder: "LabTrax Backups (test)" };
      },
    ),
    uploadBackupFileToOneDrive: vi.fn(
      async (filePath: string, fileName: string, options: { signal?: AbortSignal } = {}) => {
        const { readFileSync, statSync } = await import("node:fs");
        const size = statSync(filePath).size;
        fake.archiveBytes.set(fileName, readFileSync(filePath));
        const item = {
          id: `item_${fake.stored.size + 1}`,
          name: fileName,
          size,
          createdDateTime: new Date().toISOString(),
          webUrl: null,
        };
        fake.stored.set(item.id, item);
        fake.uploads.push({ fileName, signal: options.signal, size });
        return { itemId: item.id, fileName, size, webUrl: null, folder: "LabTrax Backups (test)" };
      },
    ),
    // Verification reads the archive back by the identity the upload returned.
    getOneDriveFileByName: vi.fn(async (name: string, _folder?: string, itemId?: string) => {
      if (_folder?.includes("/production-content-v1/")) {
        const item = fake.protectionObjects.get(`${_folder}\0${name}`);
        return item && (!itemId || item.id === itemId) ? item : null;
      }
      if (itemId) return fake.stored.get(itemId) ?? null;
      return [...fake.stored.values()].find((f) => f.name === name) ?? null;
    }),
    listOneDriveBackupFiles: vi.fn(async (folder?: string) =>
      folder?.includes("/production-content-v1/")
        ? [...fake.protectionObjects].filter(([key]) => key.startsWith(`${folder}\0`)).map(([, item]) => item)
        : [...fake.stored.values()]),
    pruneOneDriveBackups: vi.fn(async () => []),
  };
});

async function assertLargeMediaRoundtrip(
  dbMod: typeof import("@workspace/db"),
  backupMod: typeof import("../lib/backup.js"),
  eq: typeof import("drizzle-orm")["eq"],
  inArray: typeof import("drizzle-orm")["inArray"],
) {
    requireIsolatedRestoreTest();
    const originalDeployment = process.env["REPLIT_DEPLOYMENT"];
    const root = await mkdtemp(path.join(os.tmpdir(), "full-media-roundtrip-"));
    const uploadsRoot = path.join(root, "uploads");
    const localDestination = path.join(root, "destination");
    const fixtureId = randomUUID();
    const caseId = `large-backup-${fixtureId}`;
    const modernCaseId = `modern-${fixtureId}`;
    const labId = `lab-${fixtureId}`;
    const practiceId = `practice-${fixtureId}`;
    const noteId = `note-${fixtureId}`;
    const attachmentId = `attachment-${fixtureId}`;
    const { db, users, labCases, backupRuns } = dbMod as any;
    let createdUserId: string | undefined;
    fake.mediaObjects.clear();
    fake.archiveBytes.clear();
    fake.failMediaCopy = false;
    fake.blockMediaCopy = false;
    const bytes = Buffer.alloc(8 * 1024 * 1024, 0x5a);
    const names = Array.from({ length: 24 }, (_, index) => `large-${fixtureId}-${index}.${index === 0 ? "mp4" : index === 1 ? "pdf" : "bin"}`);
    for (const name of names) fake.mediaObjects.set(name, bytes);
    const recoveryClasses = [
      "legacy-case-data-backups/run/original-case.json", "lab-logos/lab.png",
      "invoice-template-images/lab/stamp.png", "case-print-template-images/lab/signature.svg",
      "support-reports/attachment.pdf", "case-media/.retained-evidence/evidence.json",
    ];
    const recoveryBytes = Buffer.from("synthetic private historical recovery evidence\n");
    for (const name of recoveryClasses) fake.privateObjects.set(name, recoveryBytes);
    seedSyntheticReleaseIdentity();
    await mkdir(path.join(uploadsRoot, "profile-photos"), { recursive: true });
    await writeFile(path.join(uploadsRoot, "profile-photos", "probe.jpg"), recoveryBytes);
    await dbMod.pool.query("CREATE TABLE public.backup_all_table_probe (id integer PRIMARY KEY, note text)");
    await dbMod.pool.query("INSERT INTO public.backup_all_table_probe VALUES (1, 'isolated coverage probe')");
    try {
      let owner = (await db.select({ id: users.id }).from(users).limit(1))[0];
      if (!owner) {
        [owner] = await db.insert(users).values({
          username: `backup_perf_${fixtureId}`, password: "x", role: "admin", userType: "lab",
        }).returning({ id: users.id });
        createdUserId = owner.id;
      }
      await dbMod.pool.query("INSERT INTO organizations (id, type, name) VALUES ($1, 'lab', 'Synthetic recovery lab'), ($2, 'provider', 'Synthetic recovery practice')", [labId, practiceId]);
      await dbMod.pool.query(`INSERT INTO cases
        (id, case_number, lab_organization_id, provider_organization_id, patient_first_name,
          patient_last_name, doctor_name, created_by_user_id)
        VALUES ($1, $5, $2, $3, 'Synthetic', 'Recovery', 'Synthetic Doctor', $4)`,
        [modernCaseId, labId, practiceId, owner.id, modernCaseId]);
      await dbMod.pool.query(`INSERT INTO case_notes (id, case_id, author_user_id, author_organization_id, note_text)
        VALUES ($1, $2, $3, $4, $5)`, [noteId, modernCaseId, owner.id, labId,
        `Original structured note /uploads/case-media/${names[1]}`]);
      await dbMod.pool.query(`INSERT INTO case_attachments
        (id, case_id, uploaded_by_user_id, uploaded_by_organization_id, file_name, storage_key, file_type)
        VALUES ($1, $2, $3, $4, $5, $5, 'application/pdf')`, [attachmentId, modernCaseId, owner.id, labId, names[1]]);
      await dbMod.pool.query(`INSERT INTO case_events (case_id, event_type, metadata_json)
        VALUES ($1, 'note_added', $2)`,
        [modernCaseId, JSON.stringify({ noteId, attachmentId, storageKey: names[1] })]);
      await db.insert(labCases).values({
        id: caseId, ownerId: owner.id,
        caseData: JSON.stringify({
          photos: names.map((name) => `/api/cases/attachment-file/${name}`),
          videos: [`/uploads/case-media/${names[0]}`],
          activityLog: [{ id: "note-probe", type: "note", description: "Original note content",
            attachmentId: "association-probe", imageUri: `/uploads/case-media/${names[1]}` }],
        }),
      });
      process.env["REPLIT_DEPLOYMENT"] = "1";
      backupMod._setUploadsRootForTests(uploadsRoot);
      const local = await backupMod.runBackup("test:large-media-local", "local", localDestination);
      const offsite = await backupMod.runBackup("test:large-media-offsite", "onedrive");
      expect(local.mediaFileCount).toBe(25);
      expect(offsite.mediaFileCount).toBe(25);
      expect(offsite.remoteItemId).toBeTruthy();
      const localBytes = await readFile(path.join(localDestination, local.fileName));
      const offsiteBytes = fake.archiveBytes.get(offsite.fileName)!;
      const archives = [localBytes, offsiteBytes].map((encrypted) =>
        new AdmZip(backupMod.decryptBuffer(encrypted)),
      );
      for (const archive of archives) {
        const recovery = JSON.parse(archive.getEntry("complete-recovery.json")!.getData().toString());
        expect(recovery.coverageVersion).toBe(2);
        expect(recovery.sourceEnvironment).toBe("production");
        expect(recovery.sourceRevision).toBe(SYNTHETIC_SOURCE_REVISION);
        expect(recovery.backupScope).toBe("production-data");
        expect(recovery.releaseIdentity).toBeUndefined();
        expect(archive.getEntries().some(entry => entry.entryName.startsWith("private-objects/desktop-installer/"))).toBe(false);
        expect(recovery.tables.find((table: { name: string }) => table.name === "backup_all_table_probe")?.rows).toBe(1);
        expect(archive.getEntry("local-uploads/profile-photos/probe.jpg")!.getData().equals(recoveryBytes)).toBe(true);
        for (const name of recoveryClasses) {
          const archivePath = name.startsWith("case-media/") ? `media/${name.slice("case-media/".length)}` : `private-objects/${name}`;
          expect(archive.getEntry(archivePath)!.getData().equals(recoveryBytes)).toBe(true);
        }
      }
      await dbMod.pool.query("DELETE FROM public.backup_all_table_probe");
      for (const zip of archives) {
        const manifest = JSON.parse(zip.getEntry("manifest.json")!.getData().toString());
        expect(manifest.mediaBytes).toBe(192 * 1024 * 1024 + recoveryBytes.length);
        expect(manifest.mediaFileCount).toBe(25);
        for (const name of names) expect(zip.getEntry(`media/${name}`)!.getData().equals(bytes)).toBe(true);
      }
      // The enclosing suite only runs with the disposable database marker.
      // Leave production mode before restore so no production timer starts.
      if (originalDeployment === undefined) delete process.env["REPLIT_DEPLOYMENT"];
      else process.env["REPLIT_DEPLOYMENT"] = originalDeployment;
      const isolatedRoot = process.env.LABTRAX_ISOLATED_RESTORE_ROOT;
      try {
        delete process.env.LABTRAX_ISOLATED_RESTORE_ROOT;
        expect(() => backupMod.parseAndValidateBackupManifest(offsiteBytes)).toThrow(/require an isolated workspace/);
        await expect(backupMod.executeRestore(offsiteBytes, "gate:refused-live-restore"))
          .rejects.toThrow(/require an isolated workspace/);
        expect((await dbMod.pool.query("SELECT count(*)::int AS count FROM public.backup_all_table_probe")).rows[0].count).toBe(0);
        expect(fake.restoredObjects.size).toBe(0);
      } finally {
        process.env.LABTRAX_ISOLATED_RESTORE_ROOT = isolatedRoot;
      }
      process.env.PRIVATE_OBJECT_DIR = "synthetic-test-bucket/isolated/";
      await expect(backupMod.executeRestore(offsiteBytes, "gate:refused-source-namespace"))
        .rejects.toThrow(/source private object namespace/);
      expect((await dbMod.pool.query("SELECT count(*)::int AS count FROM public.backup_all_table_probe")).rows[0].count).toBe(0);
      expect(fake.restoredObjects.size).toBe(0);
      const downloaded = path.join(root, "downloaded-complete.zip.enc");
      await writeFile(downloaded, offsiteBytes);
      process.env.PRIVATE_OBJECT_DIR = "/synthetic-test-bucket/isolated-restore";
      const restored = await backupMod.executeRestoreFile(downloaded, "gate:large-media-roundtrip");
      expect(restored.manifest.mediaFileCount).toBe(25);
      for (const name of names) expect((await readFile(path.resolve(process.cwd(), "uploads", "case-media", name))).equals(bytes)).toBe(true);
      expect((await dbMod.pool.query("SELECT note FROM public.backup_all_table_probe")).rows[0]?.note).toBe("isolated coverage probe");
      for (const name of recoveryClasses) expect(fake.restoredObjects.get(name)?.equals(recoveryBytes)).toBe(true);
      const legacy = await dbMod.pool.query("SELECT case_data FROM public.lab_cases WHERE id = $1", [caseId]);
      expect(JSON.parse(legacy.rows[0].case_data).activityLog[0].attachmentId).toBe("association-probe");
      const note = await dbMod.pool.query("SELECT note_text FROM case_notes WHERE id = $1", [noteId]);
      expect(note.rows[0]?.note_text).toBe(`Original structured note /uploads/case-media/${names[1]}`);
      const history = await dbMod.pool.query("SELECT metadata_json FROM case_events WHERE case_id = $1", [modernCaseId]);
      expect(history.rows[0]?.metadata_json).toEqual({ noteId, attachmentId, storageKey: names[1] });
      const attachment = await dbMod.pool.query("SELECT storage_key FROM case_attachments WHERE id = $1 AND case_id = $2", [attachmentId, modernCaseId]);
      expect(attachment.rows[0]?.storage_key).toBe(names[1]);
    } finally {
      if (originalDeployment === undefined) delete process.env["REPLIT_DEPLOYMENT"];
      else process.env["REPLIT_DEPLOYMENT"] = originalDeployment;
      backupMod._setUploadsRootForTests(null);
      backupMod._resetBackupSchedulerForTests();
      await db.delete(labCases).where(eq(labCases.id, caseId));
      await dbMod.pool.query("DELETE FROM cases WHERE id = $1", [modernCaseId]);
      await dbMod.pool.query("DELETE FROM organizations WHERE id = ANY($1)", [[labId, practiceId]]);
      if (createdUserId) await db.delete(users).where(eq(users.id, createdUserId));
      await db.delete(backupRuns).where(inArray(backupRuns.triggeredBy, ["test:large-media-local", "test:large-media-offsite"]));
      fake.mediaObjects.clear();
      fake.privateObjects.clear();
      fake.restoredObjects.clear();
      await dbMod.pool.query("DROP TABLE IF EXISTS public.backup_all_table_probe");
      fake.archiveBytes.clear();
      for (const name of names) await rm(path.resolve(process.cwd(), "uploads", "case-media", name), { force: true });
      await rm(root, { recursive: true, force: true });
    }
}

const SHOULD_RUN =
  !!process.env["DATABASE_URL"] && !!process.env["LABTRAX_ISOLATED_RESTORE_ROOT"];
const maybe = SHOULD_RUN ? describe : describe.skip;

maybe("off-site backup job (the production timer)", () => {
  let dbMod: typeof import("@workspace/db");
  let backupMod: typeof import("../lib/backup.js");
  let eq: typeof import("drizzle-orm").eq;
  let inArray: typeof import("drizzle-orm").inArray;

  let savedSettings: Array<{ key: string; value: string | null }> = [];
  let managedKeys: string[] = [];
  let origMinBytes: string | undefined;
  let origDeployment: string | undefined;
  let origPrivateDir: string | undefined;
  let syntheticApiIdentityPath: string | undefined;

  async function writeSetting(key: string, value: string | null): Promise<void> {
    const { db, systemSettings } = dbMod as any;
    if (value === null) {
      await db.delete(systemSettings).where(eq(systemSettings.key, key));
      return;
    }
    await db
      .insert(systemSettings)
      .values({ key, value })
      .onConflictDoUpdate({ target: systemSettings.key, set: { value, updatedAt: new Date() } });
  }

  async function readSetting(key: string): Promise<string | null> {
    const { db, systemSettings } = dbMod as any;
    const rows = await db.select().from(systemSettings).where(eq(systemSettings.key, key));
    return rows[0]?.value ?? null;
  }

  async function latestBackupRun(triggeredBy: string): Promise<any> {
    const { db, backupRuns } = dbMod as any;
    const { desc } = await import("drizzle-orm");
    const rows = await db
      .select()
      .from(backupRuns)
      .where(eq(backupRuns.triggeredBy, triggeredBy))
      .orderBy(desc(backupRuns.completedAt))
      .limit(1);
    return rows[0] ?? null;
  }

  async function latestOffsiteRun(): Promise<any> {
    return latestBackupRun("scheduler:offsite");
  }

  beforeAll(async () => {
    requireIsolatedRestoreTest();
    const identityPath = fileURLToPath(new URL("../lib/build-identity.json", import.meta.url));
    const relativeIdentityPath = path.relative(path.resolve(process.env.LABTRAX_ISOLATED_RESTORE_ROOT!), identityPath);
    if (!relativeIdentityPath || relativeIdentityPath.startsWith("..") || path.isAbsolute(relativeIdentityPath)) {
      throw new Error("Synthetic API build identity must stay inside the disposable restore source copy.");
    }
    // wx refuses to overwrite any real identity copied into this test tree.
    await writeFile(identityPath, JSON.stringify({ sourceRevision: SYNTHETIC_SOURCE_REVISION }), { flag: "wx" });
    syntheticApiIdentityPath = identityPath;
    origPrivateDir = process.env.PRIVATE_OBJECT_DIR;
    process.env.PRIVATE_OBJECT_DIR = "/synthetic-test-bucket/isolated";
    process.env["JWT_SECRET"] = process.env["JWT_SECRET"] ?? "labtrax-test-secret-offsite-job";
    // The gate database is schema-only, so a real archive of it is far below
    // the production plausibility floor.
    origMinBytes = process.env["BACKUP_MIN_PLAUSIBLE_BYTES"];
    origDeployment = process.env["REPLIT_DEPLOYMENT"];
    process.env["BACKUP_MIN_PLAUSIBLE_BYTES"] = "1";

    const drizzle = await import("drizzle-orm");
    eq = drizzle.eq;
    inArray = drizzle.inArray;
    dbMod = await import("@workspace/db");
    backupMod = await import("../lib/backup.js");

    managedKeys = [
      backupMod.SETTING_BACKUP_OFFSITE_ENABLED,
      backupMod.SETTING_BACKUP_OFFSITE_INTERVAL_MINUTES,
      backupMod.SETTING_BACKUP_SCHEDULE_ENABLED,
      backupMod.SETTING_BACKUP_SCHEDULE_DESTINATION,
      backupMod.SETTING_BACKUP_SCHEDULE_INTERVAL_MINUTES,
      backupMod.SETTING_BACKUP_SCHEDULE_LAST_ATTEMPT_AT,
      backupMod.SETTING_BACKUP_FULL_ARCHIVE_INTERVAL_MINUTES,
      backupMod.SETTING_BACKUP_LAST_FULL_ARCHIVE_AT,
      backupMod.SETTING_BACKUP_LAST_SUCCESSFUL_AT,
      backupMod.SETTING_BACKUP_RUN_TIMEOUT_MINUTES,
    ];
    const { db, systemSettings } = dbMod as any;
    const rows = await db
      .select()
      .from(systemSettings)
      .where(inArray(systemSettings.key, managedKeys));
    savedSettings = managedKeys.map((key) => ({
      key,
      value: rows.find((r: { key: string }) => r.key === key)?.value ?? null,
    }));

    // Fifteen-minute off-site cadence, hourly full archives, editable
    // schedule paused — exactly the production shape this task sets up.
    await writeSetting(backupMod.SETTING_BACKUP_OFFSITE_ENABLED, "true");
    await writeSetting(backupMod.SETTING_BACKUP_OFFSITE_INTERVAL_MINUTES, "15");
    await writeSetting(backupMod.SETTING_BACKUP_SCHEDULE_ENABLED, "false");
    await writeSetting(backupMod.SETTING_BACKUP_FULL_ARCHIVE_INTERVAL_MINUTES, "60");
  }, 300000);

  afterAll(async () => {
    if (syntheticApiIdentityPath) await rm(syntheticApiIdentityPath, { force: true });
  });

  afterAll(async () => {
    if (!dbMod) return;
    backupMod?._resetBackupSchedulerForTests();
    const { db, backupRuns } = dbMod as any;
    const names = fake.uploads.map((u) => u.fileName);
    if (names.length > 0) {
      await db.delete(backupRuns).where(inArray(backupRuns.fileName, names));
    }
    for (const { key, value } of savedSettings) await writeSetting(key, value);
    if (origMinBytes === undefined) delete process.env["BACKUP_MIN_PLAUSIBLE_BYTES"];
    else process.env["BACKUP_MIN_PLAUSIBLE_BYTES"] = origMinBytes;
    if (origDeployment === undefined) delete process.env["REPLIT_DEPLOYMENT"];
    else process.env["REPLIT_DEPLOYMENT"] = origDeployment;
    if (origPrivateDir === undefined) delete process.env.PRIVATE_OBJECT_DIR;
    else process.env.PRIVATE_OBJECT_DIR = origPrivateDir;
  }, 300000);

  it("uploads a complete archive on the required cadence, under a run deadline", async () => {
    // A full archive was taken five minutes ago, so this tick is a fast one.
    const lastFullAt = new Date(Date.now() - 5 * 60_000).toISOString();
    await writeSetting(backupMod.SETTING_BACKUP_LAST_FULL_ARCHIVE_AT, lastFullAt);
    fake.uploads.length = 0;

    await backupMod.fireOffsiteBackup("interval");

    expect(fake.uploads).toHaveLength(1);
    const upload = fake.uploads[0]!;
    // Unambiguous in the filename, so the folder listing alone says which
    // archives carry media.
    expect(upload.fileName).toMatch(/-full\.zip\.enc$/);
    // The run's overall deadline reaches the upload, so a wedged transfer is
    // interrupted instead of running until the process dies.
    expect(upload.signal).toBeInstanceOf(AbortSignal);
    expect(upload.signal?.aborted).toBe(false);

    const run = await latestOffsiteRun();
    expect(run).not.toBeNull();
    expect(run.status).toBe("success");
    expect(run.fileName).toBe(upload.fileName);
    expect(run.archiveKind).toBe("complete-non-production");
    // History addresses the item OneDrive confirmed, not just a name.
    expect(typeof run.remoteItemId).toBe("string");
    expect(run.remoteItemId).toBeTruthy();
    expect(String(run.path)).toContain(run.remoteItemId);

    // A database-only run must not postpone the next media-bearing archive.
    expect(await readSetting(backupMod.SETTING_BACKUP_LAST_FULL_ARCHIVE_AT)).toBe(lastFullAt);
  }, 300000);

  it("takes the full archive when the hourly slot is due, on a later tick", async () => {
    await writeSetting(
      backupMod.SETTING_BACKUP_LAST_FULL_ARCHIVE_AT,
      new Date(Date.now() - 61 * 60_000).toISOString(),
    );
    fake.uploads.length = 0;

    // That this tick runs at all is the other half of the test: the previous
    // run released the in-flight guard, which is what a wedged run used to
    // hold until the process restarted.
    await backupMod.fireOffsiteBackup("interval");

    expect(fake.uploads).toHaveLength(1);
    expect(fake.uploads[0]!.fileName).toMatch(/-full\.zip\.enc$/);

    const run = await latestOffsiteRun();
    expect(run.archiveKind).toBe("complete-non-production");
    expect(run.fileName).toBe(fake.uploads[0]!.fileName);

    // The full-archive clock advances only on a media-bearing archive.
    const lastFullAt = await readSetting(backupMod.SETTING_BACKUP_LAST_FULL_ARCHIVE_AT);
    expect(lastFullAt).not.toBeNull();
    expect(Date.now() - new Date(lastFullAt!).getTime()).toBeGreaterThan(60 * 60_000);
  }, 300000);

  it("manual full-media backups preserve durable media and report partial coverage independently of database protection", async () => {
    const originalDeployment = process.env["REPLIT_DEPLOYMENT"];
    const uploadsRoot = await mkdtemp(path.join(os.tmpdir(), "offsite-media-test-"));
    const caseMediaDir = path.join(uploadsRoot, "case-media");
    const fixtureId = randomUUID();
    const mediaCaseId = `backup-media-${fixtureId}`;
    const missingCaseId = `backup-media-missing-${fixtureId}`;
    const durableFileName = `durable-${fixtureId}.jpg`;
    const localFileName = `local-only-${fixtureId}.jpg`;
    const missingFileName = `missing-${fixtureId}.jpg`;
    const { db, labCases, legacyCaseMedia } = dbMod as any;
    await mkdir(caseMediaDir, { recursive: true });

    process.env["REPLIT_DEPLOYMENT"] = "1";
    backupMod._setUploadsRootForTests(uploadsRoot);
    fake.failMediaCopy = false;
    fake.mediaObjects.clear();
    fake.mediaObjects.set(durableFileName, Buffer.from("durable-object-copy"));
    seedSyntheticReleaseIdentity();
    fake.uploads.length = 0;
    fake.archiveBytes.clear();

    const manualFull = () => backupMod.runBackup("scheduler:offsite", "onedrive", undefined, {
      archiveKind: "full",
    }).catch(() => undefined);

    try {
      await db.insert(labCases).values({
        id: mediaCaseId,
        ownerId: mediaCaseId,
        caseData: JSON.stringify({
          photo: `/api/cases/attachment-file/${durableFileName}`,
        }),
      });
      await writeSetting(
        backupMod.SETTING_BACKUP_LAST_FULL_ARCHIVE_AT,
        new Date(Date.now() - 61 * 60_000).toISOString(),
      );
      await manualFull();

      expect(fake.uploads).toHaveLength(1);
      const run = await latestOffsiteRun();
      expect(run.status).toBe("success");
      expect(run.archiveKind).toBe("complete-production");
      expect(run.mediaFileCount).toBe(1);

      const encrypted = fake.archiveBytes.get(fake.uploads[0]!.fileName);
      expect(encrypted).toBeDefined();
      const zip = new AdmZip(backupMod.decryptBuffer(encrypted!));
      const manifest = JSON.parse(zip.getEntry("manifest.json")!.getData().toString("utf8"));
      const recovery = JSON.parse(zip.readAsText("complete-recovery.json"));
      expect(recovery.sourceRevision).toBe(SYNTHETIC_SOURCE_REVISION);
      expect(recovery.backupScope).toBe("production-data");
      expect(recovery.releaseIdentity).toBeUndefined();
      expect(zip.getEntries().some(entry => entry.entryName.startsWith("private-objects/desktop-installer/"))).toBe(false);
      expect(fake.protectionObjects.size).toBeGreaterThan(0);
      const { getDatabaseProtectionStatus } = await import("../lib/database-protection-job.js");
      expect((await getDatabaseProtectionStatus(undefined, "onedrive")).state).toBe("verified");
      expect(manifest.mediaFileCount).toBe(1);
      expect(manifest.mediaBytes).toBe(Buffer.byteLength("durable-object-copy"));
      expect(zip.getEntry(`media/${durableFileName}`)!.getData().toString()).toBe(
        "durable-object-copy",
      );

      await db.insert(legacyCaseMedia).values({
        fileName: localFileName,
        labCaseId: mediaCaseId,
        ownerId: mediaCaseId,
      });
      await writeFile(path.join(caseMediaDir, durableFileName), "stale-local-copy");
      await writeFile(path.join(caseMediaDir, localFileName), "legacy-local-copy");
      await writeSetting(
        backupMod.SETTING_BACKUP_LAST_FULL_ARCHIVE_AT,
        new Date(Date.now() - 61 * 60_000).toISOString(),
      );
      fake.uploads.length = 0;
      fake.archiveBytes.clear();
      await manualFull();
      expect(fake.uploads).toHaveLength(1);
      const unionRun = await latestOffsiteRun();
      expect(unionRun.status).toBe("success");
      expect(unionRun.mediaFileCount).toBe(2);
      const unionEncrypted = fake.archiveBytes.get(fake.uploads[0]!.fileName);
      expect(unionEncrypted).toBeDefined();
      const unionZip = new AdmZip(backupMod.decryptBuffer(unionEncrypted!));
      expect(unionZip.getEntry(`media/${durableFileName}`)!.getData().toString()).toBe(
        "durable-object-copy",
      );
      expect(unionZip.getEntry(`media/${localFileName}`)!.getData().toString()).toBe(
        "legacy-local-copy",
      );

      // Save readable originals and all database rows, but never advance the
      // complete-recovery clock when an original is unavailable.
      await db.insert(labCases).values({
        id: missingCaseId,
        ownerId: missingCaseId,
        caseData: JSON.stringify({
          photo: `/uploads/case-media/${missingFileName}`,
        }),
      });
      const missingReferenceFullAt = new Date(Date.now() - 61 * 60_000).toISOString();
      await writeSetting(backupMod.SETTING_BACKUP_LAST_FULL_ARCHIVE_AT, missingReferenceFullAt);
      fake.uploads.length = 0;
      fake.archiveBytes.clear();
      await manualFull();
      expect(fake.uploads).toHaveLength(1);
      const partialRun = await latestOffsiteRun();
      expect(partialRun.status).toBe("success");
      expect(partialRun.archiveKind).toBe("partial-production");
      expect(partialRun.partialFailure).toBe(true);
      expect(partialRun.warnings).toMatch(/not a complete recovery point/i);
      expect(partialRun.error).toBeNull();
      const partialZip = new AdmZip(backupMod.decryptBuffer(
        fake.archiveBytes.get(fake.uploads[0]!.fileName)!,
      ));
      expect(JSON.parse(partialZip.readAsText("missing-files.json"))).toMatchObject({
        missingFileCount: 1, missingReferences: [`case-media/${missingFileName}`],
      });
      expect(partialZip.readFile(`media/${durableFileName}`)?.toString()).toBe("durable-object-copy");
      expect(partialZip.readFile(`media/${localFileName}`)?.toString()).toBe("legacy-local-copy");
      expect(await db.select().from(labCases).where(eq(labCases.id, missingCaseId))).toHaveLength(1);
      expect(await readSetting(backupMod.SETTING_BACKUP_LAST_FULL_ARCHIVE_AT)).toBe(
        missingReferenceFullAt,
      );

      fake.failMediaCopy = true;
      fake.uploads.length = 0;
      fake.archiveBytes.clear();
      const storageFailureFullAt = new Date(Date.now() - 61 * 60_000).toISOString();
      await writeSetting(backupMod.SETTING_BACKUP_LAST_FULL_ARCHIVE_AT, storageFailureFullAt);
      await manualFull();
      expect(fake.uploads).toHaveLength(0);
      const storageFailureRun = await latestOffsiteRun();
      expect(storageFailureRun.status).toBe("error");
      expect(storageFailureRun.error).toMatch(/backup did not complete/i);
      expect(storageFailureRun.error).not.toContain("test App Storage read failure");
      expect(await readSetting(backupMod.SETTING_BACKUP_LAST_FULL_ARCHIVE_AT)).toBe(
        storageFailureFullAt,
      );
    } finally {
      backupMod._setUploadsRootForTests(null);
      fake.mediaObjects.clear();
      fake.failMediaCopy = false;
      try {
        await db.delete(legacyCaseMedia).where(eq(legacyCaseMedia.fileName, localFileName));
        await db.delete(labCases).where(inArray(labCases.id, [mediaCaseId, missingCaseId]));
      } finally {
        await rm(uploadsRoot, { recursive: true, force: true });
        if (originalDeployment === undefined) delete process.env["REPLIT_DEPLOYMENT"];
        else process.env["REPLIT_DEPLOYMENT"] = originalDeployment;
      }
    }
  }, 300000);

  it("records skipped/busy database protection without disturbing an existing legacy full-media job", async () => {
    const originalDeployment = process.env["REPLIT_DEPLOYMENT"];
    const uploadsRoot = await mkdtemp(path.join(os.tmpdir(), "offsite-overlap-test-"));
    const lastFullSetting = backupMod.SETTING_BACKUP_LAST_FULL_ARCHIVE_AT;
    const scheduleSettings = [
      backupMod.SETTING_BACKUP_SCHEDULE_ENABLED,
      backupMod.SETTING_BACKUP_SCHEDULE_DESTINATION,
      backupMod.SETTING_BACKUP_SCHEDULE_INTERVAL_MINUTES,
      lastFullSetting,
    ];
    const previousSettings = await Promise.all(
      scheduleSettings.map(async (key) => ({ key, value: await readSetting(key) })),
    );
    const signals: { mediaCopyStarted: () => void; releaseMediaCopy: () => void } = {
      mediaCopyStarted: () => undefined,
      releaseMediaCopy: () => undefined,
    };
    const mediaCopyStarted = new Promise<void>((resolve) => {
      signals.mediaCopyStarted = resolve;
    });
    const mediaCopyGate = new Promise<void>((resolve) => {
      signals.releaseMediaCopy = resolve;
    });
    let scheduledRun: Promise<unknown> | null = null;
    const priorProtection = await (await import("../lib/database-protection-job")).getDatabaseProtectionStatus(undefined, "onedrive");

    try {
      // Claim the real shared slot through the legacy runner, then simulate
      // the production database timer arriving while that older job remains.
      process.env["REPLIT_DEPLOYMENT"] = "0";
      backupMod.setScheduledBackupRunnerForTests(async () => {
        signals.mediaCopyStarted();
        await mediaCopyGate;
        throw new Error("test full archive media staging timeout");
      });
      backupMod._setUploadsRootForTests(uploadsRoot);
      fake.uploads.length = 0;
      fake.archiveBytes.clear();
      fake.mediaObjects.clear();
      fake.failMediaCopy = false;
      fake.failAfterBlockedMediaCopy = false;
      fake.blockMediaCopy = true;
      fake.mediaCopyStarted = () => signals.mediaCopyStarted();
      fake.mediaCopyGate = mediaCopyGate;

      const fullArchiveAt = new Date(Date.now() - 61 * 60_000).toISOString();
      await writeSetting(backupMod.SETTING_BACKUP_SCHEDULE_ENABLED, "true");
      await writeSetting(backupMod.SETTING_BACKUP_SCHEDULE_DESTINATION, "onedrive");
      await writeSetting(backupMod.SETTING_BACKUP_SCHEDULE_INTERVAL_MINUTES, "15");
      await writeSetting(lastFullSetting, fullArchiveAt);

      scheduledRun = backupMod.fireScheduledBackup();
      await mediaCopyStarted;
      process.env["REPLIT_DEPLOYMENT"] = "1";

      // No competing dump or media job may start, and a skipped interval is
      // not a failed or newly verified recovery point.
      await backupMod.fireOffsiteBackup("interval");

      expect(fake.uploads).toHaveLength(0);
      const protection = await (await import("../lib/database-protection-job")).getDatabaseProtectionStatus();
      expect(protection.state).toBe("skipped_busy");
      expect(protection.lastVerifiedAt).toBe(priorProtection.lastVerifiedAt);
      expect(protection.point).toEqual(priorProtection.point);
      expect(await readSetting(lastFullSetting)).toBe(fullArchiveAt);

      fake.failAfterBlockedMediaCopy = true;
      signals.releaseMediaCopy();
      await scheduledRun;
      scheduledRun = null;

      expect(fake.uploads).toHaveLength(0);
      // This injected runner owns no archive/history writer. Its rejection
      // releases the real slot without turning the skipped database interval
      // into either a successful recovery point or a fabricated archive row.
      expect((await (await import("../lib/database-protection-job")).getDatabaseProtectionStatus(undefined, "onedrive")).lastVerifiedAt).toBe(priorProtection.lastVerifiedAt);
      expect(await readSetting(lastFullSetting)).toBe(fullArchiveAt);
    } finally {
      signals.releaseMediaCopy();
      await scheduledRun?.catch(() => undefined);
      backupMod.setScheduledBackupRunnerForTests(null);
      fake.blockMediaCopy = false;
      fake.mediaCopyStarted = null;
      fake.mediaCopyGate = null;
      fake.mediaObjects.clear();
      fake.failMediaCopy = false;
      fake.failAfterBlockedMediaCopy = false;
      backupMod._setUploadsRootForTests(null);
      for (const { key, value } of previousSettings) await writeSetting(key, value);
      await rm(uploadsRoot, { recursive: true, force: true });
      if (originalDeployment === undefined) delete process.env["REPLIT_DEPLOYMENT"];
      else process.env["REPLIT_DEPLOYMENT"] = originalDeployment;
    }
  }, 300000);
  it("backs up a large complete production-media source to both destinations and restores it only in isolation",
    () => assertLargeMediaRoundtrip(dbMod, backupMod, eq, inArray), 300_000);
});
